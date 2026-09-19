import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { LocalCharacterSource } from "../src/character-source";
import { FakeModerator } from "./fake-moderator";
import { ECONOMY, type CharacterSummary } from "@tebakani/shared";

const characters: CharacterSummary[] = [
  { id: "a", name: "Monkey D. Luffy", series: "One Piece", description: "Monkey D. Luffy is a rubber pirate captain." },
  { id: "b", name: "Roronoa Zoro", series: "One Piece", description: "Roronoa Zoro is a three-sword fighter." },
  ...Array.from({ length: 10 }, (_, index) => ({ id: `x${index}`, name: `Candidate ${index}`, series: "Other", description: `Distinct clue ${index}.` }))
];

async function setup() {
  const ctx = createApp(":memory:", new LocalCharacterSource(characters), { moderator: new FakeModerator("yes") });
  const host = ctx.repo.createRoom("Host");
  const guest = ctx.repo.joinRoom(host.room.code, "Guest");
  if (guest.status !== "success") throw new Error("setup failed");
  await ctx.app.handle(new Request(`http://localhost/rooms/${host.room.code}/start`, { method: "POST", headers: { Authorization: `Bearer ${host.sessionToken}` } }));
  const game = ctx.gameRepo.getGameByRoomId(host.room.id)!;
  const active = ctx.turnRepo.getActiveTurn(game.id)!;
  const activeAuth = active.turn.activePlayerId === host.player.id ? host : guest;
  const answererAuth = active.turn.activePlayerId === host.player.id ? guest : host;
  return { ...ctx, host, guest, game, active, activeAuth, answererAuth };
}

function post(app: any, url: string, token: string, body: unknown) {
  return app.handle(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
}

async function openQuestion(ctx: Awaited<ReturnType<typeof setup>>) {
  const base = `http://localhost/rooms/${ctx.host.room.code}/game`;
  await post(ctx.app, `${base}/question`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, question: "Question?" });
  await ctx.awaitEvaluations();
  return base;
}

describe("Milestone 5 economy and hints", () => {
  it("settles every eligible matching persisted answer exactly once and persists awards", async () => {
    const ctx = await setup();
    const base = await openQuestion(ctx);
    await post(ctx.app, `${base}/answer`, ctx.answererAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, answer: "yes" });
    const [first, second] = await Promise.all([
      post(ctx.app, `${base}/close-answers`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id }),
      post(ctx.app, `${base}/close-answers`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id })
    ]);
    expect([first.status, second.status].sort()).toEqual([409, 409]);
    const state = ctx.db.prepare("SELECT point_balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(ctx.game.id, ctx.answererAuth.player.id) as any;
    expect(state.point_balance).toBe(1);
    const question = ctx.db.prepare("SELECT id FROM questions WHERE turn_id = ?").get(ctx.active.turn.id) as any;
    const ledger = ctx.db.prepare("SELECT * FROM point_ledger WHERE question_id = ?").all(question.id) as any[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("answer_match");
    expect(ledger[0].amount).toBe(1);
    const refreshed = await (await ctx.app.handle(new Request(base, { headers: { Authorization: `Bearer ${ctx.answererAuth.sessionToken}` } }))).json();
    expect(refreshed.currentTurn.question.awards).toEqual([{ playerId: ctx.answererAuth.player.id, amount: 1 }]);
    expect(() => ctx.db.run("UPDATE point_ledger SET amount = 99")).toThrow();
    expect(() => ctx.db.run("DELETE FROM point_ledger")).toThrow();
  });

  it("requires active human turn, expected turn and allowed phase without charging failures", async () => {
    const ctx = await setup();
    const url = `http://localhost/rooms/${ctx.host.room.code}/game/hints`;
    ctx.db.run("UPDATE player_game_state SET point_balance = 10 WHERE game_id = ?", [ctx.game.id]);
    expect((await post(ctx.app, url, ctx.activeAuth.sessionToken, { expectedTurnId: "stale", type: "series" })).status).toBe(409);
    expect((await post(ctx.app, url, ctx.activeAuth.sessionToken, { expectedTurnId: "   ", type: "series" })).status).toBe(400);
    expect((await post(ctx.app, url, ctx.answererAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "series" })).status).toBe(403);
    expect((await post(ctx.app, url, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "series" })).status).toBe(409);
    expect(ctx.db.prepare("SELECT * FROM purchased_hints").all()).toHaveLength(0);
    expect(ctx.db.prepare("SELECT * FROM point_ledger").all()).toHaveLength(0);
  });

  it("purchases once under concurrency with exact costs and private persisted data", async () => {
    const ctx = await setup();
    await openQuestion(ctx);
    ctx.db.run("UPDATE player_game_state SET point_balance = 10 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.activeAuth.player.id]);
    const url = `http://localhost/rooms/${ctx.host.room.code}/game/hints`;
    const body = { expectedTurnId: ctx.active.turn.id, type: "candidates" };
    const [first, second] = await Promise.all([post(ctx.app, url, ctx.activeAuth.sessionToken, body), post(ctx.app, url, ctx.activeAuth.sessionToken, body)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const success = await (first.status === 200 ? first : second).json();
    expect(success.hint.cost).toBe(ECONOMY.hintCosts.candidates);
    expect(success.hint.value.length).toBeLessThanOrEqual(10);
    expect(new Set(success.hint.value.map((name: string) => name.toLowerCase())).size).toBe(success.hint.value.length);
    const actualName = ctx.gameRepo.getPlayerGameStates(ctx.game.id).find((state) => state.playerId === ctx.activeAuth.player.id)!.character.name;
    expect(success.hint.value.filter((name: string) => name === actualName)).toHaveLength(1);
    expect(JSON.stringify(success.hint)).not.toContain("correct");
    expect(success.game.ownHints).toHaveLength(1);
    expect(success.game.ownLedger[0].hintPurchaseId).toBe(success.hint.id);
    const otherView = await (await ctx.app.handle(new Request(`http://localhost/rooms/${ctx.host.room.code}/game`, { headers: { Authorization: `Bearer ${ctx.answererAuth.sessionToken}` } }))).json();
    expect(otherView.ownHints).toHaveLength(0);
    expect(otherView.ownLedger).toHaveLength(0);
    expect(otherView.players.find((player: any) => player.playerId === ctx.activeAuth.player.id).pointBalance).toBe(7);
  });

  it("creates BASIC from metadata without any full or partial name disclosure", async () => {
    const ctx = await setup();
    await openQuestion(ctx);
    ctx.db.run("UPDATE player_game_state SET point_balance = 10 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.activeAuth.player.id]);
    const response = await post(ctx.app, `http://localhost/rooms/${ctx.host.room.code}/game/hints`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "basic" });
    expect(response.status).toBe(200);
    const payload = await response.json();
    const character = ctx.gameRepo.getPlayerGameStates(ctx.game.id).find((state) => state.playerId === ctx.activeAuth.player.id)!.character;
    expect(payload.hint.cost).toBe(1);
    for (const part of character.name.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 1)) expect(payload.hint.value.toLowerCase()).not.toContain(part.toLowerCase());
  });

  it("fails BASIC closed after NFKC normalization for fullwidth and single-character names", async () => {
    const source = new LocalCharacterSource([
      { id: "one", name: "Ａ 李", series: "S", description: "Ａ and 李" },
      { id: "two", name: "Other", series: "S", description: "Safe clue" }
    ]);
    const ctx = createApp(":memory:", source, { moderator: new FakeModerator("yes") });
    const host = ctx.repo.createRoom("Host");
    const guest = ctx.repo.joinRoom(host.room.code, "Guest");
    if (guest.status !== "success") throw new Error("setup failed");
    await ctx.gameService.startGame(host.room.code, host.player.id);
    const game = ctx.gameRepo.getGameByRoomId(host.room.id)!;
    const active = ctx.turnRepo.getActiveTurn(game.id)!;
    const token = active.turn.activePlayerId === host.player.id ? host.sessionToken : guest.sessionToken;
    ctx.db.run("UPDATE player_game_state SET assigned_character_id = 'redaction-target', character_name = 'Ａ 李', character_description = 'Ａ and 李', character_snapshot_json = ?, point_balance = 10 WHERE game_id = ? AND player_id = ?", [JSON.stringify({ id: "redaction-target", name: "Ａ 李", series: "S", description: "Ａ and 李" }), game.id, active.turn.activePlayerId]);
    await post(ctx.app, `http://localhost/rooms/${host.room.code}/game/question`, token, { expectedTurnId: active.turn.id, question: "Q?" });
    await ctx.awaitEvaluations();
    const response = await post(ctx.app, `http://localhost/rooms/${host.room.code}/game/hints`, token, { expectedTurnId: active.turn.id, type: "basic" });
    expect(response.status).toBe(409);
    expect(ctx.db.prepare("SELECT * FROM purchased_hints").all()).toHaveLength(0);
  });

  it("uses legacy character columns when snapshot JSON is null or malformed", async () => {
    for (const snapshot of [null, "null", "{}", "not-json"]) {
      const ctx = await setup();
      await openQuestion(ctx);
      ctx.db.run("UPDATE player_game_state SET character_name = 'Safe Hero', character_series = 'Series', character_description = 'A resilient rubber pirate captain.', character_snapshot_json = ?, point_balance = 10 WHERE game_id = ? AND player_id = ?", [snapshot, ctx.game.id, ctx.activeAuth.player.id]);
      const response = await post(ctx.app, `http://localhost/rooms/${ctx.host.room.code}/game/hints`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "basic" });
      expect(response.status).toBe(200);
    }
  });

  it("does not redact a single-letter middle initial inside unrelated words", async () => {
    const ctx = await setup();
    await openQuestion(ctx);
    ctx.db.run("UPDATE player_game_state SET assigned_character_id = 'luffy', character_name = 'Monkey D. Luffy', character_description = 'A resilient rubber pirate captain.', character_snapshot_json = ?, point_balance = 10 WHERE game_id = ? AND player_id = ?", [JSON.stringify({ id: "luffy", name: "Monkey D. Luffy", series: "One Piece", description: "A resilient rubber pirate captain." }), ctx.game.id, ctx.activeAuth.player.id]);
    const response = await post(ctx.app, `http://localhost/rooms/${ctx.host.room.code}/game/hints`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "basic" });
    expect(response.status).toBe(200);
    expect((await response.json()).hint.value).toBe("A resilient rubber pirate captain.");
  });

  it("rolls back the balance when persistence fails after deduction", async () => {
    const ctx = await setup();
    await openQuestion(ctx);
    ctx.db.run("UPDATE player_game_state SET point_balance = 10 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.activeAuth.player.id]);
    ctx.db.run("CREATE TRIGGER reject_hint BEFORE INSERT ON purchased_hints BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
    const response = await post(ctx.app, `http://localhost/rooms/${ctx.host.room.code}/game/hints`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "series" });
    expect(response.status).toBe(500);
    expect(ctx.db.prepare("SELECT point_balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(ctx.game.id, ctx.activeAuth.player.id)).toEqual({ point_balance: 10 });
    expect(ctx.db.prepare("SELECT COUNT(*) count FROM purchased_hints").get()).toEqual({ count: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) count FROM point_ledger").get()).toEqual({ count: 0 });
  });

  it("rejects completed purchases with 403 and validates corrupted persisted hint JSON", async () => {
    const ctx = await setup();
    await openQuestion(ctx);
    ctx.db.run("UPDATE player_game_state SET point_balance = 10, has_guessed_correctly = 1 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.activeAuth.player.id]);
    const response = await post(ctx.app, `http://localhost/rooms/${ctx.host.room.code}/game/hints`, ctx.activeAuth.sessionToken, { expectedTurnId: ctx.active.turn.id, type: "series" });
    expect(response.status).toBe(403);
    ctx.db.run("UPDATE player_game_state SET has_guessed_correctly = 0 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.activeAuth.player.id]);
    ctx.db.run("INSERT INTO purchased_hints (id, game_id, player_id, hint_type, hint_value, cost, purchased_at) VALUES (?, ?, ?, 'series', 'not-json', 2, ?)", ["bad", ctx.game.id, ctx.activeAuth.player.id, new Date().toISOString()]);
    expect(ctx.economyRepo.getHints(ctx.game.id, ctx.activeAuth.player.id)).toEqual([]);
  });
});
