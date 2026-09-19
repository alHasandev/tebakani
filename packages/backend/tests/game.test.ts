import { describe, it, expect } from "bun:test";
import { createApp } from "../src/app";
import { LocalCharacterSource } from "../src/character-source";
import type { CharacterSource, CharacterSummary } from "@tebakani/shared";
import { FakeModerator } from "./fake-moderator";

describe("Milestone 2 Game API & Service", () => {
  it("rejects start when unauthorized or invalid bearer token", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room } = repo.createRoom("Host");

    // No auth header
    const resNoAuth = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST"
      })
    );
    expect(resNoAuth.status).toBe(401);

    // Invalid bearer token
    const resInvalid = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: "Bearer invalid-token-123456" }
      })
    );
    expect(resInvalid.status).toBe(401);
  });

  it("prevents non-host player from starting the game with 403", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room } = repo.createRoom("Host");
    const guest = repo.joinRoom(room.code, "Guest");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    const res = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${guest.sessionToken}` }
      })
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Only the host can start the game");
  });

  it("enforces minimum two players to start game with 400", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room, sessionToken } = repo.createRoom("SoloHost");

    const res = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("At least 2 players are required to start");
  });

  it("creates game with required schema values, playing status, timestamps, and default completion flags", async () => {
    const { app, repo, db } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room, sessionToken, player: host } = repo.createRoom("Host");
    const guest = repo.joinRoom(room.code, "Guest");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    const startRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );
    expect(startRes.status).toBe(200);

    // Direct SQLite check for required columns and values
    const gameRow = db.prepare("SELECT * FROM games WHERE room_id = ?").get(room.id) as any;
    expect(gameRow).toBeDefined();
    expect(gameRow.id).toBeDefined();
    expect(gameRow.room_id).toBe(room.id);
    expect(gameRow.status).toBe("playing");
    expect(gameRow.created_at).toBeDefined();
    expect(gameRow.started_at).toBeDefined();
    expect(gameRow.finished_at).toBeNull();

    const pgsRows = db.prepare("SELECT * FROM player_game_state WHERE game_id = ?").all(gameRow.id) as any[];
    expect(pgsRows).toHaveLength(2);
    for (const pgs of pgsRows) {
      expect(pgs.has_guessed_correctly).toBe(0);
      expect(pgs.completed_at).toBeNull();
      expect(pgs.assigned_character_id).toBeDefined();
      expect(pgs.turn_order).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects late joins once a game exists with 409 and does not insert new player", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room, sessionToken } = repo.createRoom("Host");
    repo.joinRoom(room.code, "Guest1");

    // Start game
    const startRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );
    expect(startRes.status).toBe(200);

    // Attempt join after game exists
    const lateJoinRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "LateComer" })
      })
    );

    expect(lateJoinRes.status).toBe(409);
    const body = await lateJoinRes.json();
    expect(body.error).toContain("game is already");

    // Verify LateComer was NOT inserted into players table
    const players = repo.getPlayers(room.id);
    expect(players).toHaveLength(2);
    expect(players.some((p) => p.name === "LateComer")).toBe(false);
  });

  it("handles concurrent starts giving exactly one 200 and one 409 and one complete game", async () => {
    const { app, repo, db } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room, sessionToken } = repo.createRoom("Host");
    repo.joinRoom(room.code, "Guest1");

    // Send two simultaneous start requests
    const [res1, res2] = await Promise.all([
      app.handle(
        new Request(`http://localhost/rooms/${room.code}/start`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionToken}` }
        })
      ),
      app.handle(
        new Request(`http://localhost/rooms/${room.code}/start`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionToken}` }
        })
      )
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Verify exactly one game exists in the database
    const gameCount = db.prepare("SELECT COUNT(*) as count FROM games WHERE room_id = ?").get(room.id) as any;
    expect(gameCount.count).toBe(1);
  });

  it("accepts CharacterSource test double and handles too few or duplicate characters safely without partial DB state", async () => {
    // Test double returning duplicate characters
    const duplicateSource: CharacterSource = {
      async getCharacterById() {
        return null;
      },
      async getRandomCharacters() {
        return [
          { id: "dup-1", name: "Clone", series: "S1" },
          { id: "dup-1", name: "Clone", series: "S1" }
        ];
      }
    };

    const { app, repo, db } = createApp(":memory:", duplicateSource, { moderator: new FakeModerator() });
    const { room, sessionToken } = repo.createRoom("Host");
    repo.joinRoom(room.code, "Guest1");

    const res = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Not enough unique characters");

    // Verify transaction rollback: no game or player_game_state was persisted
    const game = db.prepare("SELECT * FROM games WHERE room_id = ?").get(room.id);
    expect(game).toBeNull();
    const pgs = db.prepare("SELECT * FROM player_game_state").all();
    expect(pgs).toHaveLength(0);
  });

  it("rejects joins and concurrent starts with 409 while character fetching is deferred/pending and preserves existing players", async () => {
    let resolveSourcePromise: (chars: CharacterSummary[]) => void;
    let sourceInvokedPromise = new Promise<void>((resolve) => {
      // Deferred source
    });
    let notifySourceInvoked: () => void;
    const invokedSignal = new Promise<void>((resolve) => {
      notifySourceInvoked = resolve;
    });

    const deferredPromise = new Promise<CharacterSummary[]>((resolve) => {
      resolveSourcePromise = resolve;
    });

    let fetchCount = 0;
    const deferredSource: CharacterSource = {
      async getCharacterById() {
        return null;
      },
      async getRandomCharacters(count: number) {
        fetchCount++;
        notifySourceInvoked();
        return deferredPromise;
      }
    };

    const { app, repo, gameService, gameRepo } = createApp(":memory:", deferredSource, { moderator: new FakeModerator() });
    const { room, sessionToken } = repo.createRoom("Host");
    const guest1 = repo.joinRoom(room.code, "Guest1");
    expect(guest1.status).toBe("success");

    // Begin start request (will block waiting on deferredPromise)
    const startPromise = app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );

    // Wait until CharacterSource is actively invoked
    await invokedSignal;
    expect(gameService.isRoomStarting(room.id)).toBe(true);
    expect(gameService.isRoomStarting(room.code)).toBe(true);
    expect(fetchCount).toBe(1);

    // Attempt join while start is pending
    const joinWhilePendingRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "RacerPlayer" })
      })
    );
    expect(joinWhilePendingRes.status).toBe(409);
    const joinErr = await joinWhilePendingRes.json();
    expect(joinErr.error).toContain("game is already");

    // Verify RacerPlayer was not inserted
    const playersMidFlight = repo.getPlayers(room.id);
    expect(playersMidFlight).toHaveLength(2);
    expect(playersMidFlight.some((p) => p.name === "RacerPlayer")).toBe(false);

    // Attempt second start while lock is held
    const secondStartRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );
    expect(secondStartRes.status).toBe(409);
    // Ensure second start did not trigger a second character fetch
    expect(fetchCount).toBe(1);

    // Now release the deferred character source
    resolveSourcePromise!([
      { id: "c-1", name: "Char One", series: "Series One" },
      { id: "c-2", name: "Char Two", series: "Series Two" }
    ]);

    const startRes = await startPromise;
    expect(startRes.status).toBe(200);

    // Verify lock is released after completion
    expect(gameService.isRoomStarting(room.id)).toBe(false);

    // Verify all preexisting players (and only them) were assigned
    const game = gameRepo.getGameByRoomId(room.id);
    expect(game).not.toBeNull();
    const assignedStates = gameRepo.getPlayerGameStates(game!.id);
    expect(assignedStates).toHaveLength(2);
    const assignedPlayerNames = assignedStates.map((s) => s.playerName).sort();
    expect(assignedPlayerNames).toEqual(["Guest1", "Host"]);
  });

  it("rejects alias-equivalent game assignments within the same normalized series", async () => {
    const source: CharacterSource = {
      getCharacterById: async () => null,
      getRandomCharacters: async () => [
        { id: "remote", name: "Eren Jaeger", series: "Attack on Titan", knowledge: { aliases: ["Eren Yeager"] } },
        { id: "local", name: "Eren Yeager", series: " ＡＴＴＡＣＫ ON TITAN " }
      ]
    };
    const { app, repo } = createApp(":memory:", source, { moderator: new FakeModerator() });
    const { room, sessionToken } = repo.createRoom("Host");
    expect(repo.joinRoom(room.code, "Guest").status).toBe("success");
    const response = await app.handle(new Request(`http://localhost/rooms/${room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Not enough unique characters available to start game" });
  });

  it("assigns unique characters across every player, assigns AI correctly, and enforces raw REST secrecy", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const { room, sessionToken, player: host } = repo.createRoom("Host");
    const guest1 = repo.joinRoom(room.code, "Guest1", "human");
    const aiPlayer = repo.joinRoom(room.code, "AI-Bot", "ai");
    expect(guest1.status).toBe("success");
    expect(aiPlayer.status).toBe("success");
    if (guest1.status !== "success" || aiPlayer.status !== "success") return;

    const startRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );
    expect(startRes.status).toBe(200);

    // Host view
    const hostGameRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/game`, {
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    );
    expect(hostGameRes.status).toBe(200);
    const hostRawText = await hostGameRes.text();
    const hostGame = JSON.parse(hostRawText);

    // Guest view
    const guestGameRes = await app.handle(
      new Request(`http://localhost/rooms/${room.code}/game`, {
        headers: { Authorization: `Bearer ${guest1.sessionToken}` }
      })
    );
    expect(guestGameRes.status).toBe(200);
    const guestRawText = await guestGameRes.text();
    const guestGame = JSON.parse(guestRawText);

    // AI player is present with AI type
    const aiInGame = hostGame.players.find((p: any) => p.playerId === aiPlayer.player.id);
    expect(aiInGame).toBeDefined();
    expect(aiInGame.playerType).toBe("ai");
    expect(aiInGame.character).toBeDefined();

    // Find host's actual assigned character as viewed by guest
    const hostCharInGuestView = guestGame.players.find((p: any) => p.playerId === host.id).character;
    expect(hostCharInGuestView).toBeDefined();

    // Verify hostRawText contains NONE of host's own character fields
    expect(hostRawText).not.toContain(hostCharInGuestView.id);
    expect(hostRawText).not.toContain(hostCharInGuestView.name);
    if (hostCharInGuestView.description) {
      expect(hostRawText).not.toContain(hostCharInGuestView.description);
    }

    // Find guest's actual assigned character as viewed by host
    const guestCharInHostView = hostGame.players.find((p: any) => p.playerId === guest1.player.id).character;
    expect(guestCharInHostView).toBeDefined();

    // Verify guestRawText contains NONE of guest's own character fields
    expect(guestRawText).not.toContain(guestCharInHostView.id);
    expect(guestRawText).not.toContain(guestCharInHostView.name);

    // All characters assigned across the 3 players are distinct
    const assignedIds = new Set([
      hostCharInGuestView.id,
      guestCharInHostView.id,
      aiInGame.character.id
    ]);
    expect(assignedIds.size).toBe(3);
  });
});
