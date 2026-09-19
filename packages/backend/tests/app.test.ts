import { describe, it, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";

describe("TebakAni Room & Player API", () => {
  let app: ReturnType<typeof createApp>["app"];
  let repo: ReturnType<typeof createApp>["repo"];

  beforeEach(() => {
    const created = createApp(":memory:");
    app = created.app;
    repo = created.repo;
  });

  it("creates a room with secure 6-char code and host player", async () => {
    const res = await app.handle(
      new Request("http://localhost/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Alice", playerType: "human" })
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.room).toBeDefined();
    expect(body.room.code).toBeDefined();
    expect(body.room.code).toHaveLength(6);
    // Should be uppercase and exclude 0, O, 1, I, L
    expect(body.room.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

    expect(body.player).toBeDefined();
    expect(body.player.name).toBe("Alice");
    expect(body.player.type).toBe("human");
    expect(body.player.isHost).toBe(true);
    expect(body.sessionToken).toBeDefined();
    expect(body.sessionToken.length).toBeGreaterThan(20);
  });

  it("rejects AI room creation because AI players are host-managed", async () => {
    const res = await app.handle(
      new Request("http://localhost/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Bot-1", playerType: "ai" })
      })
    );

    expect(res.status).toBe(403);
  });

  it("rejects invalid player types with 4xx or 422 validation error", async () => {
    const res = await app.handle(
      new Request("http://localhost/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Alice", playerType: "alien" })
      })
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects empty player name", async () => {
    const res = await app.handle(
      new Request("http://localhost/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "   " })
      })
    );

    expect(res.status).toBe(400);
  });

  it("joins an existing room by code successfully", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Alice" })
      })
    );
    const created = await createRes.json();
    const code = created.room.code;

    const joinRes = await app.handle(
      new Request(`http://localhost/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Bob", playerType: "human" })
      })
    );

    expect(joinRes.status).toBe(200);
    const joinBody = await joinRes.json();
    expect(joinBody.room.code).toBe(code);
    expect(joinBody.player.name).toBe("Bob");
    expect(joinBody.player.isHost).toBe(false);
    expect(joinBody.sessionToken).toBeDefined();

    // Verify room state does not leak session tokens
    const lobbyRes = await app.handle(new Request(`http://localhost/rooms/${code}`));
    expect(lobbyRes.status).toBe(200);
    const lobby = await lobbyRes.json();
    expect(lobby.players).toHaveLength(2);
    expect(lobby.players[0].name).toBe("Alice");
    expect(lobby.players[1].name).toBe("Bob");
    expect(lobby.players[0].sessionToken).toBeUndefined();
    expect(lobby.players[1].sessionToken).toBeUndefined();
  });

  it("returns 404 when joining a non-existent room", async () => {
    const res = await app.handle(
      new Request("http://localhost/rooms/NONEX1/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName: "Stranger" })
      })
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Room not found");
  });

  it("authenticates player with valid session token and rejects invalid tokens", () => {
    const { sessionToken, player } = repo.createRoom("HostPlayer");
    
    const authed = repo.authenticatePlayer(sessionToken);
    expect(authed).not.toBeNull();
    expect(authed?.player.id).toBe(player.id);
    expect(authed?.player.name).toBe("HostPlayer");

    const invalid = repo.authenticatePlayer("fake-token-1234567890");
    expect(invalid).toBeNull();
  });

  it("tracks player connected flag correctly", () => {
    const { player } = repo.createRoom("PresenceTester");
    expect(player.connected).toBe(false);

    repo.setPlayerConnected(player.id, true);
    const playersConnected = repo.getPlayers(player.roomId);
    expect(playersConnected[0].connected).toBe(true);

    repo.setPlayerConnected(player.id, false);
    const playersDisconnected = repo.getPlayers(player.roomId);
    expect(playersDisconnected[0].connected).toBe(false);
  });
});
