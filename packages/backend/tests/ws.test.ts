import { describe, it, expect } from "bun:test";
import { createApp } from "../src/app";
import { createDatabase } from "../src/db";
import { RoomRepository } from "../src/repository";
import { unlinkSync } from "fs";
import { FakeModerator } from "./fake-moderator";

function expectViewerCharacters(frame: string, ownPlayerId: string, own: any, otherPlayerId: string, other: any) {
  const payload = JSON.parse(frame).data;
  const ownView = payload.players.find((player: any) => player.playerId === ownPlayerId);
  const otherView = payload.players.find((player: any) => player.playerId === otherPlayerId);
  expect(ownView.character).toBeUndefined();
  expect(otherView.character).toEqual({ id: other.assigned_character_id, name: other.character_name, series: other.character_series, imageUrl: other.character_image_url ?? undefined, description: other.character_description ?? undefined });
  expect(Object.keys(ownView)).not.toContain("assigned_character_id");
  expect(JSON.stringify(payload.ownHints)).not.toContain(own.character_name);
}

describe("WebSocket presence & multi-connection integration", () => {
  it("authorizes valid session token and rejects invalid token over WS", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const server = app.listen(0);
    const port = server.server?.port;

    const { sessionToken } = repo.createRoom("WsHost");

    // Connect with valid token
    const validWs = new WebSocket(`ws://localhost:${port}/ws?token=${sessionToken}`);
    const validConnected = await new Promise<boolean>((resolve) => {
      validWs.onopen = () => resolve(true);
      validWs.onerror = () => resolve(false);
    });
    expect(validConnected).toBe(true);

    // Should receive initial lobby_update message
    const msg = await new Promise<any>((resolve) => {
      validWs.onmessage = (event) => {
        resolve(JSON.parse(event.data.toString()));
      };
    });
    expect(msg.type).toBe("lobby_update");
    expect(msg.data.players[0].name).toBe("WsHost");

    validWs.close();

    // Connect with invalid token
    const invalidWs = new WebSocket(`ws://localhost:${port}/ws?token=invalid_token_12345`);
    const errorReceived = await new Promise<boolean>((resolve) => {
      invalidWs.onmessage = (event) => {
        const payload = JSON.parse(event.data.toString());
        if (payload.type === "error") {
          resolve(true);
        }
      };
      invalidWs.onclose = () => resolve(true);
      invalidWs.onerror = () => resolve(true);
    });
    expect(errorReceived).toBe(true);

    server.stop();
  });

  it("updates player to online on connect and offline on disconnect", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const server = app.listen(0);
    const port = server.server?.port;

    const { sessionToken, player } = repo.createRoom("DisconnectTester");
    expect(repo.getPlayers(player.roomId)[0].connected).toBe(false);

    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${sessionToken}`);
    await new Promise((resolve) => (ws.onopen = resolve));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(repo.getPlayers(player.roomId)[0].connected).toBe(true);

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(repo.getPlayers(player.roomId)[0].connected).toBe(false);

    server.stop();
  });

  it("tracks multiple sockets sharing a token and marks offline only when final socket closes", async () => {
    const { app, repo, presence } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const server = app.listen(0);
    const port = server.server?.port;

    const { sessionToken, player } = repo.createRoom("MultiTabPlayer");

    const ws1 = new WebSocket(`ws://localhost:${port}/ws?token=${sessionToken}`);
    await new Promise((resolve) => (ws1.onopen = resolve));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(repo.getPlayers(player.roomId)[0].connected).toBe(true);
    expect(presence.getConnectionCount(player.id)).toBe(1);

    const ws2 = new WebSocket(`ws://localhost:${port}/ws?token=${sessionToken}`);
    await new Promise((resolve) => (ws2.onopen = resolve));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(presence.getConnectionCount(player.id)).toBe(2);
    expect(repo.getPlayers(player.roomId)[0].connected).toBe(true);

    // Close first socket
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Still online because ws2 is alive
    expect(presence.getConnectionCount(player.id)).toBe(1);
    expect(repo.getPlayers(player.roomId)[0].connected).toBe(true);

    // Close second socket
    ws2.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Now marked offline
    expect(presence.getConnectionCount(player.id)).toBe(0);
    expect(repo.getPlayers(player.roomId)[0].connected).toBe(false);

    server.stop();
  });

  it("delivers per-player sanitized game_started and game_state payloads over WS to all active player tabs with strict secrecy", async () => {
    const { app, repo, db } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const server = app.listen(0);
    const port = server.server?.port;

    const host = repo.createRoom("HostPlayer");
    const guest = repo.joinRoom(host.room.code, "GuestPlayer");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    // Open two sockets for Host (simulating two open browser tabs) and one for Guest
    const hostTab1 = new WebSocket(`ws://localhost:${port}/ws?token=${host.sessionToken}`);
    const hostTab2 = new WebSocket(`ws://localhost:${port}/ws?token=${host.sessionToken}`);
    const guestTab = new WebSocket(`ws://localhost:${port}/ws?token=${guest.sessionToken}`);

    await Promise.all([
      new Promise((res) => (hostTab1.onopen = res)),
      new Promise((res) => (hostTab2.onopen = res)),
      new Promise((res) => (guestTab.onopen = res))
    ]);

    const hostTab1Raw: string[] = [];
    const hostTab2Raw: string[] = [];
    const guestTabRaw: string[] = [];

    hostTab1.onmessage = (e) => hostTab1Raw.push(e.data.toString());
    hostTab2.onmessage = (e) => hostTab2Raw.push(e.data.toString());
    guestTab.onmessage = (e) => guestTabRaw.push(e.data.toString());

    // Start game via POST /rooms/:code/start
    const startRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    expect(startRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const host1Frame = hostTab1Raw.find((s) => s.includes("game_started"));
    const host2Frame = hostTab2Raw.find((s) => s.includes("game_started"));
    const guestFrame = guestTabRaw.find((s) => s.includes("game_started"));

    expect(host1Frame).toBeDefined();
    expect(host2Frame).toBeDefined();
    expect(guestFrame).toBeDefined();

    // Directly query database to find exact assigned characters
    const roomRecord = repo.getRoomByCode(host.room.code)!;
    const gameRecord = db.prepare("SELECT id FROM games WHERE room_id = ?").get(roomRecord.id) as any;
    const dbAssignments = db.prepare(`
      SELECT player_id, assigned_character_id, character_name, character_series, character_image_url, character_description
      FROM player_game_state WHERE game_id = ?
    `).all(gameRecord.id) as any[];

    const hostActualChar = dbAssignments.find((a) => a.player_id === host.player.id);
    const guestActualChar = dbAssignments.find((a) => a.player_id === guest.player.id);

    expect(hostActualChar).toBeDefined();
    expect(guestActualChar).toBeDefined();

    for (const frame of [host1Frame!, host2Frame!]) expectViewerCharacters(frame, host.player.id, hostActualChar, guest.player.id, guestActualChar);
    expectViewerCharacters(guestFrame!, guest.player.id, guestActualChar, host.player.id, hostActualChar);

    // Now issue a mutation (question asked by active player) and verify per-viewer game_state broadcast
    const hostEvent1 = JSON.parse(host1Frame!);
    const activePlayerId = hostEvent1.data.currentTurn.activePlayerId;
    const activeToken = activePlayerId === host.player.id ? host.sessionToken : guest.sessionToken;
    const activeTurnId = hostEvent1.data.currentTurn.id;

    hostTab1Raw.length = 0;
    hostTab2Raw.length = 0;
    guestTabRaw.length = 0;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: activeTurnId, question: "Are we anime heroes?" })
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    const host1StateFrame = hostTab1Raw.find((s) => s.includes("game_state"));
    const host2StateFrame = hostTab2Raw.find((s) => s.includes("game_state"));
    const guestStateFrame = guestTabRaw.find((s) => s.includes("game_state"));

    expect(host1StateFrame).toBeDefined();
    expect(host2StateFrame).toBeDefined();
    expect(guestStateFrame).toBeDefined();

    for (const frame of [host1StateFrame!, host2StateFrame!]) expectViewerCharacters(frame, host.player.id, hostActualChar, guest.player.id, guestActualChar);
    expectViewerCharacters(guestStateFrame!, guest.player.id, guestActualChar, host.player.id, hostActualChar);

    hostTab1.close();
    hostTab2.close();
    guestTab.close();
    server.stop();
  });

  it("completes a two-human game and ensures every connected tab receives exactly one game_finished event with safe payload", async () => {
    const { app, repo, db, awaitEvaluations } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const server = app.listen(0);
    const port = server.server?.port;

    const host = repo.createRoom("FinishHost");
    const guest = repo.joinRoom(host.room.code, "FinishGuest");
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    // Connect two sockets for Host (two tabs) and one socket for Guest
    const hostTab1 = new WebSocket(`ws://localhost:${port}/ws?token=${host.sessionToken}`);
    const hostTab2 = new WebSocket(`ws://localhost:${port}/ws?token=${host.sessionToken}`);
    const guestTab = new WebSocket(`ws://localhost:${port}/ws?token=${guest.sessionToken}`);

    await Promise.all([
      new Promise((res) => (hostTab1.onopen = res)),
      new Promise((res) => (hostTab2.onopen = res)),
      new Promise((res) => (guestTab.onopen = res))
    ]);

    const hostTab1Events: any[] = [];
    const hostTab2Events: any[] = [];
    const guestTabEvents: any[] = [];

    hostTab1.onmessage = (e) => hostTab1Events.push(JSON.parse(e.data.toString()));
    hostTab2.onmessage = (e) => hostTab2Events.push(JSON.parse(e.data.toString()));
    guestTab.onmessage = (e) => guestTabEvents.push(JSON.parse(e.data.toString()));

    // Start game
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const roomRecord = repo.getRoomByCode(host.room.code)!;
    const gameRecord = db.prepare("SELECT id FROM games WHERE room_id = ?").get(roomRecord.id) as any;
    const dbAssignments = db.prepare(`
      SELECT player_id, character_name FROM player_game_state WHERE game_id = ?
    `).all(gameRecord.id) as any[];

    // Fetch initial state
    let gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    let gameData = await gameRes.json();
    let turnId = gameData.currentTurn.id;
    let activePlayerId = gameData.currentTurn.activePlayerId;
    let activeToken = activePlayerId === host.player.id ? host.sessionToken : guest.sessionToken;
    let otherPlayerId = activePlayerId === host.player.id ? guest.player.id : host.player.id;
    let otherToken = otherPlayerId === host.player.id ? host.sessionToken : guest.sessionToken;

    // Player 1: question -> close -> correct guess
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "First player question?" })
      })
    );
    await awaitEvaluations();
    db.run("UPDATE questions SET answer_deadline_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = ?", [turnId]);
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId })
      })
    );

    const p1Char = dbAssignments.find((a) => a.player_id === activePlayerId).character_name;
    const guess1Res = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, characterName: p1Char })
      })
    );
    expect(guess1Res.status).toBe(200);

    // Player 2 turn: question -> close -> correct guess (finishes game!)
    gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${otherToken}` }
      })
    );
    gameData = await gameRes.json();
    const turn2Id = gameData.currentTurn.id;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn2Id, question: "Second player question?" })
      })
    );
    await awaitEvaluations();
    db.run("UPDATE questions SET answer_deadline_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = ?", [turn2Id]);
    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/close-answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn2Id })
      })
    );

    // Clear event history right before final guess to assert exact delivery of game_finished
    hostTab1Events.length = 0;
    hostTab2Events.length = 0;
    guestTabEvents.length = 0;

    const p2Char = dbAssignments.find((a) => a.player_id === otherPlayerId).character_name;
    const finalGuessRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ expectedTurnId: turn2Id, characterName: p2Char })
      })
    );
    expect(finalGuessRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Assert every tab received exactly one game_finished event
    const host1Fin = hostTab1Events.filter((e) => e.type === "game_finished");
    const host2Fin = hostTab2Events.filter((e) => e.type === "game_finished");
    const guestFin = guestTabEvents.filter((e) => e.type === "game_finished");

    expect(host1Fin).toHaveLength(1);
    expect(host2Fin).toHaveLength(1);
    expect(guestFin).toHaveLength(1);

    // Assert final payload properties: status is finished, currentTurn is null, finishedAt set
    for (const fin of [host1Fin[0].data, host2Fin[0].data, guestFin[0].data]) {
      expect(fin.status).toBe("finished");
      expect(fin.currentTurn).toBeNull();
      expect(fin.currentTurnPlayerId).toBeNull();
      expect(fin.finishedAt).not.toBeNull();
      expect(fin.players).toHaveLength(2);
      // Because BOTH players completed, both players' characters are visible in final payload
      expect(fin.players[0].hasGuessedCorrectly).toBe(true);
      expect(fin.players[0].character).toBeDefined();
      expect(fin.players[0].character.name).toBeDefined();
      expect(fin.players[1].hasGuessedCorrectly).toBe(true);
      expect(fin.players[1].character).toBeDefined();
      expect(fin.players[1].character.name).toBeDefined();
    }

    hostTab1.close();
    hostTab2.close();
    guestTab.close();
    server.stop();
  });

  it("restores question, submitted answers, and selected answer on reconnect during collecting_answers", async () => {
    const { app, repo } = createApp(":memory:", undefined, { moderator: new FakeModerator() });
    const server = app.listen(0);
    const port = server.server?.port;

    const host = repo.createRoom("RecHost");
    const guest = repo.joinRoom(host.room.code, "RecGuest");
    const observer = repo.joinRoom(host.room.code, "RecObserver");
    expect(guest.status).toBe("success");
    expect(observer.status).toBe("success");
    if (guest.status !== "success" || observer.status !== "success") return;

    const allPlayers = [
      { id: host.player.id, token: host.sessionToken },
      { id: guest.player.id, token: guest.sessionToken },
      { id: observer.player.id, token: observer.sessionToken },
    ];

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );

    const gameRes = await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game`, {
        headers: { Authorization: `Bearer ${host.sessionToken}` }
      })
    );
    const game = await gameRes.json();
    const turnId = game.currentTurn.id;
    const activePlayerId = game.currentTurn.activePlayerId;
    const activeToken = allPlayers.find((p) => p.id === activePlayerId)!.token;
    const nonActive = allPlayers.find((p) => p.id !== activePlayerId)!;
    const nonActivePlayerId = nonActive.id;
    const nonActiveToken = nonActive.token;

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, question: "Do I have black hair?" })
      })
    );

    await app.handle(
      new Request(`http://localhost/rooms/${host.room.code}/game/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${nonActiveToken}` },
        body: JSON.stringify({ expectedTurnId: turnId, answer: "maybe" })
      })
    );

    const reconnectedWs = new WebSocket(`ws://localhost:${port}/ws?token=${nonActiveToken}`);
    const messages: any[] = [];
    reconnectedWs.onmessage = (e) => messages.push(JSON.parse(e.data.toString()));

    await new Promise((res) => (reconnectedWs.onopen = res));
    await new Promise((res) => setTimeout(res, 80));

    const gameMsg = messages.find((m) => m.type === "game_started" || m.type === "game_state");
    expect(gameMsg).toBeDefined();
    expect(gameMsg.data.currentTurn.phase).toBe("collecting_answers");
    expect(gameMsg.data.currentTurn.question.questionText).toBe("Do I have black hair?");

    const myAnswerInTurn = gameMsg.data.currentTurn.question.answers.find((a: any) => a.playerId === nonActivePlayerId);
    expect(myAnswerInTurn).toBeDefined();
    expect(myAnswerInTurn.answer).toBe("maybe");

    reconnectedWs.close();
    server.stop();
  });

  it("resets stale persisted connected flags on database opening/restart", () => {
    const testDbPath = "test_restart.sqlite";
    try {
      unlinkSync(testDbPath);
    } catch {}

    // First process run
    const db1 = createDatabase(testDbPath);
    const repo1 = new RoomRepository(db1);
    const { player } = repo1.createRoom("StalePlayer");

    repo1.setPlayerConnected(player.id, true);
    expect(repo1.getPlayers(player.roomId)[0].connected).toBe(true);
    db1.close();

    // Restart process / re-open db
    const db2 = createDatabase(testDbPath);
    const repo2 = new RoomRepository(db2);
    expect(repo2.getPlayers(player.roomId)[0].connected).toBe(false);

    db2.close();
    try {
      unlinkSync(testDbPath);
    } catch {}
  });
});
