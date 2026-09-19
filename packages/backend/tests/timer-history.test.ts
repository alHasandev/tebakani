import { describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { createApp } from "../src/app";
import { LocalCharacterSource } from "../src/character-source";
import { FakeModerator } from "./fake-moderator";
import { COMPLETE_CHARACTERS, IMMEDIATE_RUNTIME, ScriptedAIPlayerAgent, ZERO_DELAY_CONFIG } from "./ai-player-helpers";

async function request(app: ReturnType<typeof createApp>["app"], path: string, token?: string, body?: unknown) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "PATCH",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

describe("timer and history completion", () => {
  it("enforces answer timer settings and locks the game snapshot", async () => {
    const value = createApp(":memory:", new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new FakeModerator() });
    const host = value.repo.createRoom("Host");
    const guest = value.repo.joinRoom(host.room.code, "Guest");
    const other = value.repo.createRoom("Other");
    if (guest.status !== "success") throw new Error("setup failed");
    expect(host.room.answerDurationSeconds).toBe(60);
    for (const seconds of [15, 60, 300]) {
      const response = await request(value.app, `/rooms/${host.room.code}/settings/answer-timer`, host.sessionToken, { answerDurationSeconds: seconds });
      expect(response.status).toBe(200);
      expect((await response.json()).room.answerDurationSeconds).toBe(seconds);
    }
    expect((await request(value.app, `/rooms/${host.room.code}/settings/answer-timer`, undefined, { answerDurationSeconds: 60 })).status).toBe(401);
    expect((await request(value.app, `/rooms/${host.room.code}/settings/answer-timer`, other.sessionToken, { answerDurationSeconds: 60 })).status).toBe(403);
    expect((await request(value.app, `/rooms/${host.room.code}/settings/answer-timer`, guest.sessionToken, { answerDurationSeconds: 60 })).status).toBe(403);
    for (const invalid of [14, 301, 60.5]) expect((await request(value.app, `/rooms/${host.room.code}/settings/answer-timer`, host.sessionToken, { answerDurationSeconds: invalid })).status).toBe(400);
    await value.gameService.startGame(host.room.code, host.player.id);
    const game = value.gameRepo.getGameByRoomId(host.room.id)!;
    expect(game.answerDurationSeconds).toBe(300);
    value.db.run("UPDATE rooms SET answer_duration_seconds = 15 WHERE id = ?", [host.room.id]);
    expect(value.gameRepo.getGameByRoomId(host.room.id)!.answerDurationSeconds).toBe(300);
    expect((await request(value.app, `/rooms/${host.room.code}/settings/answer-timer`, host.sessionToken, { answerDurationSeconds: 60 })).status).toBe(409);
    await value.aiRunner.stop();
  });

  it("persists an exact custom ISO deadline and rejects insert/update at the boundary", async () => {
    let now = Date.parse("2026-09-19T12:00:00.000Z");
    const runtime = { ...IMMEDIATE_RUNTIME, now: () => now };
    const value = createApp(":memory:", new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new FakeModerator(), aiRuntime: runtime });
    const host = value.repo.createRoom("Host");
    const guest = value.repo.joinRoom(host.room.code, "Guest");
    if (guest.status !== "success") throw new Error("setup failed");
    value.repo.updateAnswerDuration(host.room.id, host.player.id, 15);
    const started = await value.gameService.startGame(host.room.code, host.player.id);
    const turn = value.turnRepo.getActiveTurn(started.game.id)!;
    const active = turn.turn.activePlayerId === host.player.id ? host : guest;
    const answerer = active === host ? guest : host;
    await value.gameService.askQuestion(host.room.code, active.player.id, turn.turn.id, "Boundary?");
    const question = value.turnRepo.getActiveTurn(started.game.id)!.question!;
    expect(question.answerDeadlineAt).toBe("2026-09-19T12:00:15.000Z");
    now += 14_999;
    await expect(value.gameService.submitAnswer(host.room.code, answerer.player.id, turn.turn.id, "yes")).resolves.toBeDefined();
    now++;
    await expect(value.gameService.submitAnswer(host.room.code, answerer.player.id, turn.turn.id, "no")).rejects.toThrow("deadline");
    expect(value.turnRepo.getActiveTurn(started.game.id)!.answers[0].answer).toBe("yes");
    await value.aiRunner.stop();
  });

  it("returns complete chronological compact history beyond one hundred turns", async () => {
    const value = createApp(":memory:", new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new FakeModerator() });
    const host = value.repo.createRoom("Host");
    const guest = value.repo.joinRoom(host.room.code, "Guest");
    if (guest.status !== "success") throw new Error("setup failed");
    const started = await value.gameService.startGame(host.room.code, host.player.id);
    value.db.run("DELETE FROM game_turns WHERE game_id = ?", [started.game.id]);
    for (let index = 1; index <= 105; index++) {
      value.db.run("INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, 'awaiting_guess', 0, ?, ?, 'passed')", [randomUUID(), started.game.id, host.player.id, index, new Date(index * 1000).toISOString(), new Date(index * 1000 + 1).toISOString()]);
    }
    const history = value.turnRepo.listHistory(started.game.id);
    expect(history).toHaveLength(105);
    expect(history[0].turn.turnNumber).toBe(1);
    expect(history[104].turn.turnNumber).toBe(105);
    const view = value.gameService.getGameViewForPlayer(host.room.code, host.player.id)!;
    expect(view.history).toHaveLength(105);
    expect(JSON.stringify(view.history)).not.toMatch(/assigned_character|snapshot|sourceUrl|knowledge|character_description/);
    expect(Date.parse(view.serverTime)).toBeNumber();
    await value.aiRunner.stop();
  });

  it("includes hint purchase metadata in turn history without exposing the hint value", async () => {
    const value = createApp(":memory:", new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new FakeModerator() });
    const host = value.repo.createRoom("Host");
    const guest = value.repo.joinRoom(host.room.code, "Guest");
    if (guest.status !== "success") throw new Error("setup failed");
    const started = await value.gameService.startGame(host.room.code, host.player.id);
    const turn = value.turnRepo.getActiveTurn(started.game.id)!;
    const purchasedAt = new Date(Date.parse(turn.turn.startedAt) + 1).toISOString();
    value.db.run("INSERT INTO purchased_hints (id, game_id, player_id, hint_type, hint_value, cost, purchased_at, turn_id) VALUES ('history-hint', ?, ?, 'series', ?, 2, ?, ?)", [started.game.id, turn.turn.activePlayerId, JSON.stringify("Secret Series"), purchasedAt, turn.turn.id]);
    value.db.run("UPDATE game_turns SET is_active = 0, ended_at = ?, outcome = 'passed' WHERE id = ?", [new Date(Date.parse(purchasedAt) + 1).toISOString(), turn.turn.id]);
    const view = value.gameService.getGameViewForPlayer(host.room.code, host.player.id)!;
    expect(view.history[0].hintPurchases).toEqual([{ id: "history-hint", playerId: turn.turn.activePlayerId, playerName: turn.turn.activePlayerName, playerType: turn.turn.activePlayerType, hintType: "series", cost: 2, purchasedAt }]);
    expect(JSON.stringify(view.history)).not.toContain("Secret Series");
    await value.aiRunner.stop();
  });

  it("recovers an AI duplicate using pending, failed, skipped, and more than thirty prior identities", async () => {
    const agent = new ScriptedAIPlayerAgent();
    agent.questions.push("Prior question 35?", "Prior question 35?");
    const value = createApp(":memory:", new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new FakeModerator(), aiPlayerAgent: agent, aiPlayerConfig: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 }, aiRuntime: IMMEDIATE_RUNTIME });
    const host = value.repo.createRoom("Host");
    const ai = value.repo.addAIPlayers(host.room.id, ["AI"])[0];
    const started = await value.gameService.startGame(host.room.code, host.player.id);
    const active = value.turnRepo.getActiveTurn(started.game.id)!;
    value.db.run("UPDATE game_turns SET active_player_id = ? WHERE id = ?", [ai.id, active.turn.id]);
    value.db.run("UPDATE games SET current_turn_player_id = ? WHERE id = ?", [ai.id, started.game.id]);
    for (let index = 1; index <= 36; index++) {
      const turnId = randomUUID();
      const questionId = randomUUID();
      value.db.run("INSERT INTO game_turns (id, game_id, active_player_id, turn_number, phase, is_active, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, 'collecting_answers', 0, ?, ?, ?)", [turnId, started.game.id, ai.id, index + 1, new Date(index * 1000).toISOString(), new Date(index * 1000 + 1).toISOString(), index === 1 ? "skipped" : "passed"]);
      value.db.run("INSERT INTO questions (id, turn_id, asking_player_id, question_text, asked_at, moderator_status, moderator_answer, moderator_attempts, moderator_revision, answer_deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)", [questionId, turnId, ai.id, `Prior question ${index}?`, new Date(index * 1000).toISOString(), index === 2 ? "failed" : index === 3 ? "pending" : "answered", index <= 3 ? null : "yes", new Date(index * 1000 + 60000).toISOString()]);
    }
    value.aiRunner.reconcile(started.game.id);
    await value.awaitAI();
    const current = value.turnRepo.getActiveTurn(started.game.id)!;
    expect(current.question?.questionText).not.toBe("Prior question 35?");
    expect(current.question?.questionText).toBe("Is this character human?");
    expect(agent.questionContexts).toHaveLength(2);
    await value.aiRunner.stop();
  });
});
