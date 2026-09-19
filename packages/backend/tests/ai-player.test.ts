import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { AIPlayerContextRepository } from "../src/ai-player-context";
import { loadAIPlayerConfig } from "../src/ai-player-config";
import { LocalCharacterSource } from "../src/character-source";
import { FakeModerator } from "./fake-moderator";
import type { AIPlayerAgent } from "../src/ai-player-types";
import type { CharacterSummary } from "@tebakani/shared";

const characters: CharacterSummary[] = [
  { id: "secret-ai-id", name: "Secret AI Name", series: "Secret AI Series", description: "Secret AI description", imageUrl: "https://images/secret-ai.png", source: "fandom", sourceKey: "secret-wiki", sourceUrl: "https://secret.fandom.com/wiki/Secret", knowledge: { aliases: ["Hidden Alias"], abilities: ["Hidden Power"] } },
  { id: "human-id", name: "Visible Human", series: "Visible Series", description: "Visible description", imageUrl: "https://images/human.png", source: "fandom", sourceKey: "visible-wiki", sourceUrl: "https://visible.fandom.com/wiki/Human", knowledge: { aliases: ["Visible Alias"], abilities: ["Visible Power"] } },
  ...Array.from({ length: 10 }, (_, index) => ({ id: `extra-${index}`, name: `Extra ${index}`, series: "Extra", description: `Description ${index}`, imageUrl: `https://images/extra-${index}.png` }))
];

const passiveAgent: AIPlayerAgent = {
  answerQuestion: async () => "maybe",
  decideHint: async () => ({ action: "none" }),
  generateQuestion: async () => "Is this character human?",
  decideGuessOrPass: async () => ({ action: "pass" })
};

async function setup() {
  const ctx = createApp(":memory:", new LocalCharacterSource(characters), { moderator: new FakeModerator("yes"), aiPlayerAgent: passiveAgent, aiPlayerConfig: { thinkDelayMinMs: 100000, thinkDelayMaxMs: 100000, answerDelayMinMs: 100000, answerDelayMaxMs: 100000, collectionDelayMs: 100000, gameplayRetries: 1, moderatorRetries: 1 } });
  const host = ctx.repo.createRoom("Host");
  const [ai] = ctx.repo.addAIPlayers(host.room.id, ["AI"]);
  await ctx.gameService.startGame(host.room.code, host.player.id);
  const game = ctx.gameRepo.getGameByRoomId(host.room.id)!;
  const states = ctx.gameRepo.getPlayerGameStates(game.id);
  const aiState = states.find((state) => state.playerId === ai.id)!;
  const humanState = states.find((state) => state.playerId === host.player.id)!;
  ctx.db.run("UPDATE game_turns SET active_player_id = ? WHERE game_id = ? AND is_active = 1", [ai.id, game.id]);
  ctx.db.run("UPDATE games SET current_turn_player_id = ? WHERE id = ?", [ai.id, game.id]);
  const turn = ctx.turnRepo.getActiveTurn(game.id)!;
  return { ...ctx, host, ai, game, aiState, humanState, turn, contexts: new AIPlayerContextRepository(ctx.db) };
}

describe("Milestone 6 AI trust and durable policy", () => {
  it("builds self context by allowlist and exposes only legitimately purchased hint values", async () => {
    const ctx = await setup();
    ctx.db.run("UPDATE player_game_state SET point_balance = 20 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.ai.id]);
    ctx.db.run("INSERT INTO purchased_hints VALUES ('series-hint', ?, ?, 'series', ?, 2, '2026-01-01T00:00:00Z')", [ctx.game.id, ctx.ai.id, JSON.stringify(ctx.aiState.character.series)]);
    ctx.db.run("INSERT INTO purchased_hints VALUES ('candidate-hint', ?, ?, 'candidates', ?, 7, '2026-01-01T00:00:01Z')", [ctx.game.id, ctx.ai.id, JSON.stringify([ctx.aiState.character.name, "Decoy"])]);
    const context = ctx.contexts.buildSelf(ctx.game.id, ctx.ai.id, ctx.turn.turn.id);
    const serialized = JSON.stringify(context);
    expect(Object.keys(context.player).sort()).toEqual(["id", "name", "pointBalance"]);
    expect(serialized).not.toContain(ctx.aiState.character.id);
    expect(serialized).not.toContain(ctx.aiState.character.description!);
    expect(ctx.aiState.character.imageUrl).toBeDefined();
    expect(serialized).not.toContain(ctx.aiState.character.imageUrl!);
    expect(context.purchasedHints.find((hint) => hint.type === "series")?.value).toBe(ctx.aiState.character.series);
    const candidates = context.purchasedHints.find((hint) => hint.type === "candidates")?.value;
    expect(candidates).toEqual([ctx.aiState.character.name, "Decoy"]);
    expect(serialized).not.toContain("correct");
    await ctx.aiRunner.stop();
  });

  it("answer context exposes the other target and rejects self-answer context", async () => {
    const ctx = await setup();
    await ctx.gameService.askQuestionAsAI(ctx.host.room.code, { kind: "ai", playerId: ctx.ai.id }, ctx.turn.turn.id, "Question?");
    expect(() => ctx.contexts.buildAnswer(ctx.game.id, ctx.ai.id, ctx.turn.turn.id)).toThrow("own question");
    ctx.db.run("UPDATE game_turns SET active_player_id = ? WHERE id = ?", [ctx.host.player.id, ctx.turn.turn.id]);
    const answer = ctx.contexts.buildAnswer(ctx.game.id, ctx.ai.id, ctx.turn.turn.id);
    expect(answer.target.playerId).toBe(ctx.host.player.id);
    expect(answer.target.character.name).toBe(ctx.humanState.character.name);
    expect(answer.target.character.knowledge).toEqual(ctx.humanState.character.knowledge);
    expect(JSON.stringify(ctx.contexts.buildSelf(ctx.game.id, ctx.ai.id, ctx.turn.turn.id))).not.toContain("Hidden Power");
    expect(answer.answeringPlayer.id).toBe(ctx.ai.id);
    await ctx.aiRunner.stop();
  });

  it("enforces one AI hint per turn atomically while retaining normal ledger debit", async () => {
    const ctx = await setup();
    ctx.db.run("UPDATE player_game_state SET point_balance = 20 WHERE game_id = ? AND player_id = ?", [ctx.game.id, ctx.ai.id]);
    await ctx.gameService.purchaseHintAsAI(ctx.host.room.code, { kind: "ai", playerId: ctx.ai.id }, ctx.turn.turn.id, "series");
    await expect(ctx.gameService.purchaseHintAsAI(ctx.host.room.code, { kind: "ai", playerId: ctx.ai.id }, ctx.turn.turn.id, "candidates")).rejects.toThrow("at most one hint");
    expect(ctx.db.prepare("SELECT COUNT(*) count FROM ai_turn_hint_purchases").get()).toEqual({ count: 1 });
    expect(ctx.db.prepare("SELECT reason, amount FROM point_ledger").all()).toEqual([{ reason: "hint_purchase", amount: -2 }]);
    expect(ctx.db.prepare("SELECT point_balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(ctx.game.id, ctx.ai.id)).toEqual({ point_balance: 18 });
    await ctx.aiRunner.stop();
  });

  it("restricts gameplay regeneration retries to zero or one", () => {
    expect(loadAIPlayerConfig({ AI_GAMEPLAY_RETRIES: "0" }).gameplayRetries).toBe(0);
    expect(loadAIPlayerConfig({ AI_GAMEPLAY_RETRIES: "1" }).gameplayRetries).toBe(1);
    expect(() => loadAIPlayerConfig({ AI_GAMEPLAY_RETRIES: "2" })).toThrow("0 or 1");
  });
});
