import { afterEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ECONOMY, type AnswerValue, type CharacterSummary } from "@tebakani/shared";
import { createApp, LazyProductionAIPlayerAgent } from "../src/app";
import { AIPlayerContextRepository } from "../src/ai-player-context";
import { VercelAIPlayerAgent } from "../src/ai-player-agent";
import { LocalCharacterSource } from "../src/character-source";
import type { AIModerator, ModerationRequest } from "../src/ai-moderator";
import { COMPLETE_CHARACTERS, IMMEDIATE_RUNTIME, ScriptedAIPlayerAgent, ZERO_DELAY_CONFIG, deferred, drainAI, shutdown } from "./ai-player-helpers";

class ScriptedModerator implements AIModerator {
  readonly requests: ModerationRequest[] = [];
  readonly script: Array<AnswerValue | Error | Promise<AnswerValue>>;
  constructor(...script: Array<AnswerValue | Error | Promise<AnswerValue>>) { this.script = script; }
  async moderate(request: ModerationRequest): Promise<AnswerValue> {
    this.requests.push(structuredClone(request));
    const result = this.script.shift() ?? "maybe";
    if (result instanceof Error) throw result;
    return result;
  }
}

const openContexts: Array<ReturnType<typeof createApp>> = [];
const files = new Set<string>();
afterEach(async () => {
  while (openContexts.length) {
    const context = openContexts.pop()!;
    try { await shutdown(context); } catch {}
  }
  for (const path of files) {
    try { unlinkSync(path); } catch {}
    files.delete(path);
  }
});

async function fixture(options: { aiCount?: number; moderator?: AIModerator; agent?: ScriptedAIPlayerAgent; path?: string; config?: typeof ZERO_DELAY_CONFIG } = {}) {
  const agent = options.agent ?? new ScriptedAIPlayerAgent();
  const moderator = options.moderator ?? new ScriptedModerator("yes");
  const context = createApp(options.path ?? ":memory:", new LocalCharacterSource(COMPLETE_CHARACTERS), {
    moderator,
    aiPlayerAgent: agent,
    aiPlayerConfig: options.config ?? ZERO_DELAY_CONFIG,
    aiRuntime: IMMEDIATE_RUNTIME
  });
  openContexts.push(context);
  const host = context.repo.createRoom("Human");
  const ais = context.repo.addAIPlayers(host.room.id, Array.from({ length: options.aiCount ?? 1 }, (_, index) => `AI ${index + 1}`));
  await context.gameService.startGame(host.room.code, host.player.id);
  const game = context.gameRepo.getGameByRoomId(host.room.id)!;
  const states = context.gameRepo.getPlayerGameStates(game.id);
  return { ...context, context, host, ais, game, states, agent, moderator };
}

function makeActive(value: Awaited<ReturnType<typeof fixture>>, playerId: string, phase = "waiting_for_question") {
  value.db.run("UPDATE game_turns SET active_player_id = ?, phase = ? WHERE game_id = ? AND is_active = 1", [playerId, phase, value.game.id]);
  value.db.run("UPDATE games SET current_turn_player_id = ? WHERE id = ?", [playerId, value.game.id]);
  return value.turnRepo.getActiveTurn(value.game.id)!;
}

async function askAndModerate(value: Awaited<ReturnType<typeof fixture>>, playerId: string, question = "Is this character human?") {
  const turn = value.turnRepo.getActiveTurn(value.game.id)!;
  const kind = value.ais.some((ai) => ai.id === playerId) ? "ai" : "human";
  if (kind === "ai") await value.gameService.askQuestionAsAI(value.host.room.code, { kind, playerId }, turn.turn.id, question);
  else await value.gameService.askQuestion(value.host.room.code, playerId, turn.turn.id, question);
  const questionId = value.gameService.getQuestionId(value.host.room.code, turn.turn.id);
  await value.gameService.evaluateQuestion(questionId);
  return { turnId: turn.turn.id, questionId };
}

function stateFor(value: Awaited<ReturnType<typeof fixture>>, playerId: string) {
  return value.states.find((state) => state.playerId === playerId)!;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

describe("Milestone 6 production agent structured output", () => {
  const env = { openaiApiKey: "test", openaiBaseUrl: "https://example.invalid", openaiModel: "test", openaiTimeout: 1000, openaiMaxRetries: 0, fandomBaseUrl: undefined, fandomTimeout: 10000, fandomMaxRetries: 2, fandomCacheTtlSeconds: 604800 };
  const selfContext = { player: { id: "ai", name: "AI", pointBalance: 0 }, game: { id: "game", roomCode: "ROOM", turnId: "turn", turnNumber: 1, phase: "waiting_for_question" as const }, evidence: [], previousGuesses: [], purchasedHints: [], availableHintTypes: [], economy: ECONOMY.hintCosts };

  it("regenerates malformed structured output once and returns only schema-validated data", async () => {
    const outputs: unknown[] = [{ answer: "arbitrary" }, { answer: "yes" }];
    let calls = 0;
    const agent = new VercelAIPlayerAgent(env, ZERO_DELAY_CONFIG, globalThis.fetch, async () => { calls++; return outputs.shift(); });
    const context = { answeringPlayer: { id: "ai", name: "AI" }, game: { id: "game", turnId: "turn", questionId: "question" }, question: "Q?", target: { playerId: "human", playerName: "Human", character: COMPLETE_CHARACTERS[0] } };
    await expect(agent.answerQuestion(context)).resolves.toBe("yes");
    expect(calls).toBe(2);
  });

  it("requires a character guess once accumulated evidence is sufficient", async () => {
    const evidence = [
      ["Was the series first published in 2003?", "yes"],
      ["Is the character initially a high school student?", "yes"],
      ["Does the character possess a supernatural notebook?", "yes"],
      ["Is the character accompanied by a Shinigami?", "yes"],
      ["Is the character known as Kira?", "yes"],
      ["Is the primary adversary known by one letter?", "yes"]
    ].map(([question, moderatorAnswer]) => ({ question, moderatorAnswer: moderatorAnswer as "yes" }));
    let receivedSchema: { safeParse(value: unknown): { success: boolean } } | undefined;
    const agent = new VercelAIPlayerAgent(env, ZERO_DELAY_CONFIG, globalThis.fetch, async ({ schema }) => {
      receivedSchema = schema;
      return { action: "guess", characterName: "Light Yagami" };
    });
    await expect(agent.decideGuessOrPass({ ...selfContext, evidence })).resolves.toEqual({ action: "guess", characterName: "Light Yagami" });
    expect(receivedSchema?.safeParse({ action: "pass" }).success).toBe(false);
  });

  it("spends available points on the most valuable unpurchased hint", async () => {
    let calls = 0;
    const agent = new VercelAIPlayerAgent(env, ZERO_DELAY_CONFIG, globalThis.fetch, async () => { calls++; return { action: "none" }; });
    await expect(agent.decideHint({ ...selfContext, player: { ...selfContext.player, pointBalance: 3 }, availableHintTypes: ["basic", "series", "candidates"] })).resolves.toEqual({ action: "purchase", type: "candidates" });
    await expect(agent.decideHint({ ...selfContext, player: { ...selfContext.player, pointBalance: 2 }, availableHintTypes: ["basic", "series"] })).resolves.toEqual({ action: "purchase", type: "series" });
    await expect(agent.decideHint({ ...selfContext, player: { ...selfContext.player, pointBalance: 1 }, availableHintTypes: ["basic"] })).resolves.toEqual({ action: "purchase", type: "basic" });
    await expect(agent.decideHint(selfContext)).resolves.toEqual({ action: "none" });
    expect(calls).toBe(0);
  });

  it("forwards cancellation through the lazy wrapper and never starts regeneration after abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const delegate = new VercelAIPlayerAgent(env, ZERO_DELAY_CONFIG, globalThis.fetch, async ({ signal }) => {
      calls++;
      receivedSignal = signal;
      controller.abort(new Error("cancelled"));
      throw new Error("first attempt interrupted");
    });
    const wrapper = new LazyProductionAIPlayerAgent(() => delegate);
    const context = { answeringPlayer: { id: "ai", name: "AI" }, game: { id: "game", turnId: "turn", questionId: "question" }, question: "Q?", target: { playerId: "human", playerName: "Human", character: COMPLETE_CHARACTERS[0] } };
    await expect(wrapper.answerQuestion(context, controller.signal)).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
    expect(calls).toBe(1);
  });

  it("runner stop aborts an in-flight generation and resolves without a regeneration", async () => {
    let calls = 0;
    const generation = async ({ signal }: { signal?: AbortSignal }) => {
      calls++;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    };
    const agent = new VercelAIPlayerAgent(env, ZERO_DELAY_CONFIG, globalThis.fetch, generation);
    const value = await fixture({ agent: agent as unknown as ScriptedAIPlayerAgent });
    const ai = value.ais[0];
    makeActive(value, ai.id);
    value.aiRunner.reconcile(value.game.id);
    for (let index = 0; index < 20 && calls === 0; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    await value.aiRunner.stop();
    expect(calls).toBe(1);
  });

  it("bounds malformed regeneration and rejects every operation instead of casting arbitrary output", async () => {
    for (const operation of ["answer", "question", "guess"] as const) {
      let calls = 0;
      const agent = new VercelAIPlayerAgent(env, ZERO_DELAY_CONFIG, globalThis.fetch, async () => { calls++; return { arbitrary: true }; });
      const promise = operation === "answer"
        ? agent.answerQuestion({ answeringPlayer: { id: "ai", name: "AI" }, game: { id: "game", turnId: "turn", questionId: "question" }, question: "Q?", target: { playerId: "human", playerName: "Human", character: COMPLETE_CHARACTERS[0] } })
        : operation === "question" ? agent.generateQuestion(selfContext)
        : agent.decideGuessOrPass(selfContext);
      await expect(promise).rejects.toThrow("Invalid gameplay decision");
      expect(calls).toBe(2);
    }
  });
});

describe("Milestone 6 deterministic AI trust", () => {
  it("uses an allowlisted unhinted self context and reveals SERIES/CANDIDATES only after purchases", async () => {
    const value = await fixture({ config: { ...ZERO_DELAY_CONFIG, thinkDelayMinMs: 100000, thinkDelayMaxMs: 100000 } });
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id);
    const assigned = stateFor(value, ai.id).character;
    const contexts = new AIPlayerContextRepository(value.db);
    const unhinted = contexts.buildSelf(value.game.id, ai.id, turn.turn.id);
    const raw = JSON.stringify(unhinted);
    expect(Object.keys(unhinted.player).sort()).toEqual(["id", "name", "pointBalance"]);
    for (const secret of [assigned.id, assigned.name, assigned.series, assigned.description, assigned.imageUrl]) expect(raw).not.toContain(secret!);
    expect(raw).not.toContain("CharacterSummary");
    expect(raw).not.toContain("assigned_character");
    expect(unhinted.purchasedHints).toEqual([]);
    value.db.run("UPDATE player_game_state SET point_balance = 10 WHERE game_id = ? AND player_id = ?", [value.game.id, ai.id]);
    await value.gameService.purchaseHintAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "series");
    const withSeries = contexts.buildSelf(value.game.id, ai.id, turn.turn.id);
    expect(withSeries.purchasedHints).toHaveLength(1);
    expect(withSeries.purchasedHints[0].value).toBe(assigned.series);
    value.db.run("DELETE FROM ai_turn_hint_purchases WHERE turn_id = ?", [turn.turn.id]);
    await value.gameService.purchaseHintAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "candidates");
    const candidates = contexts.buildSelf(value.game.id, ai.id, turn.turn.id).purchasedHints.find((hint) => hint.type === "candidates")!.value as string[];
    expect(candidates).toContain(assigned.name);
    expect(JSON.stringify(candidates)).not.toMatch(/correct|true|false/i);
  });

  it("sends the hidden assignment to moderation and another target only to answer context", async () => {
    const moderator = new ScriptedModerator("yes");
    const value = await fixture({ moderator });
    const ai = value.ais[0];
    const aiSecret = stateFor(value, ai.id).character;
    const humanSecret = stateFor(value, value.host.player.id).character;
    const turn = makeActive(value, ai.id);
    await askAndModerate(value, ai.id);
    expect(moderator.requests[0].character).toEqual(aiSecret);
    expect(() => new AIPlayerContextRepository(value.db).buildAnswer(value.game.id, ai.id, turn.turn.id)).toThrow("own question");
    makeActive(value, value.host.player.id, "collecting_answers");
    const answerContext = new AIPlayerContextRepository(value.db).buildAnswer(value.game.id, ai.id, turn.turn.id);
    expect(answerContext.target.character).toEqual(humanSecret);
  });

  it("keeps REST GameView free of own assignment, prompts, raw output, and private AI context", async () => {
    const value = await fixture();
    const ai = value.ais[0];
    const own = stateFor(value, value.host.player.id).character;
    const view = value.gameService.getGameViewForPlayer(value.host.room.code, value.host.player.id)!;
    const raw = JSON.stringify(view);
    const hostView = view.players.find((player) => player.playerId === value.host.player.id)!;
    expect(hostView.character).toBeUndefined();
    const allVisibleCharacterIds = view.players.filter((p) => p.character).map((p) => p.character!.id);
    expect(allVisibleCharacterIds).not.toContain(own.id);
    const allVisibleCharacterNames = view.players.filter((p) => p.character).map((p) => p.character!.name);
    expect(allVisibleCharacterNames).not.toContain(own.name);
    for (const forbidden of ["systemPrompt", "prompt", "rawOutput", "assigned_character", "previousGuesses", "availableHintTypes"]) expect(raw).not.toContain(forbidden);
    expect(view.players.find((player) => player.playerId === ai.id)?.character).toBeDefined();
  });
});

describe("Milestone 6 deterministic answers and scoring", () => {
  it("persists autonomous yes, no, and maybe answers, including completed AI", async () => {
    for (const answer of ["yes", "no", "maybe"] as const) {
      const agent = new ScriptedAIPlayerAgent();
      agent.answers.push(answer);
      const value = await fixture({ agent, config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
      const ai = value.ais[0];
      makeActive(value, value.host.player.id);
      const { questionId } = await askAndModerate(value, value.host.player.id);
      value.db.run("UPDATE player_game_state SET has_guessed_correctly = 1 WHERE game_id = ? AND player_id = ?", [value.game.id, ai.id]);
      value.aiRunner.reconcile(value.game.id);
      await drainAI(value);
      expect(value.db.prepare("SELECT answer FROM turn_answers WHERE question_id = ? AND answering_player_id = ?").get(questionId, ai.id)).toEqual({ answer });
      await shutdown(value.context);
      openContexts.splice(openContexts.indexOf(value.context), 1);
    }
  });

  it("rejects AI self/outside-phase answers and makes duplicate reconciliation harmless", async () => {
    const gate = deferred<AnswerValue>();
    const agent = new ScriptedAIPlayerAgent();
    agent.answers.push(gate.promise);
    const value = await fixture({ agent, config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
    const ai = value.ais[0];
    const turn = makeActive(value, value.host.player.id);
    const { questionId } = await askAndModerate(value, value.host.player.id);
    value.aiRunner.reconcile(value.game.id);
    value.aiRunner.reconcile(value.game.id);
    for (let index = 0; index < 10 && agent.answerContexts.length === 0; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(agent.answerContexts).toHaveLength(1);
    gate.resolve("yes");
    await drainAI(value);
    expect(value.db.prepare("SELECT COUNT(*) count FROM turn_answers WHERE question_id = ? AND answering_player_id = ?").get(questionId, ai.id)).toEqual({ count: 1 });
    await expect(value.gameService.submitAnswerAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "no")).rejects.toThrow();
    makeActive(value, ai.id, "collecting_answers");
    await expect(value.gameService.submitAnswerAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "yes")).rejects.toThrow("own question");
    value.db.run("UPDATE game_turns SET phase = 'awaiting_guess' WHERE id = ?", [turn.turn.id]);
    await expect(value.gameService.submitAnswerAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "yes")).rejects.toThrow();
  });

  it("awards exactly ECONOMY.correctAnswerPoints with normal ledger reason only on match", async () => {
    const value = await fixture({ aiCount: 2, moderator: new ScriptedModerator("yes") });
    makeActive(value, value.host.player.id);
    const { turnId, questionId } = await askAndModerate(value, value.host.player.id);
    await value.gameService.submitAnswerAsAI(value.host.room.code, { kind: "ai", playerId: value.ais[0].id }, turnId, "yes");
    await value.gameService.submitAnswerAsAI(value.host.room.code, { kind: "ai", playerId: value.ais[1].id }, turnId, "no");
    await value.gameService.closeAnswers(value.host.room.code, value.host.player.id, turnId);
    expect(value.db.prepare("SELECT player_id playerId, amount, reason FROM point_ledger WHERE question_id = ?").all(questionId)).toEqual([{ playerId: value.ais[0].id, amount: ECONOMY.correctAnswerPoints, reason: "answer_match" }]);
    expect(value.db.prepare("SELECT point_balance balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(value.game.id, value.ais[1].id)).toEqual({ balance: 0 });
  });
});

describe("Milestone 6 deterministic autonomous turns, hints, and failures", () => {
  it("asks, is moderated, collects human and other-AI answers, never self-answers, then passes", async () => {
    const agent = new ScriptedAIPlayerAgent();
    agent.questions.push("Does this character use magic?");
    agent.answers.push("yes");
    agent.guesses.push({ action: "pass" });
    const moderator = new ScriptedModerator("yes");
    const value = await fixture({ aiCount: 2, agent, moderator, config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
    const active = value.ais[0];
    const other = value.ais[1];
    const turn = makeActive(value, active.id);
    value.aiRunner.reconcile(value.game.id);
    let question = value.turnRepo.getActiveTurn(value.game.id)!.question;
    for (let index = 0; index < 20 && !question; index++) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      question = value.turnRepo.getActiveTurn(value.game.id)!.question;
    }
    expect(question).not.toBeNull();
    await value.gameService.submitAnswer(value.host.room.code, value.host.player.id, turn.turn.id, "yes");
    value.aiRunner.reconcile(value.game.id);
    let answers: Array<{ id: string }> = [];
    for (let index = 0; index < 30 && answers.length < 2; index++) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      answers = value.db.prepare("SELECT answering_player_id id FROM turn_answers WHERE question_id = ? ORDER BY id").all(question!.id) as Array<{ id: string }>;
    }
    expect(answers.map((entry) => entry.id)).toContain(other.id);
    expect(answers.map((entry) => entry.id)).toContain(value.host.player.id);
    expect(answers.map((entry) => entry.id)).not.toContain(active.id);
    expect(moderator.requests[0].question).toBe("Does this character use magic?");
    for (let index = 0; index < 30 && value.turnRepo.getActiveTurn(value.game.id)!.turn.id === turn.turn.id; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(value.turnRepo.getActiveTurn(value.game.id)!.turn.id).not.toBe(turn.turn.id);
    await value.aiRunner.stop();
  });

  it("falls back safely for answer, hint, question, and guess failures", async () => {
    const answerAgent = new ScriptedAIPlayerAgent();
    answerAgent.answers.push(new Error("answer failed"));
    const answerValue = await fixture({ agent: answerAgent, config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
    makeActive(answerValue, answerValue.host.player.id);
    const { questionId } = await askAndModerate(answerValue, answerValue.host.player.id);
    answerValue.aiRunner.reconcile(answerValue.game.id);
    await drainAI(answerValue);
    expect(answerValue.db.prepare("SELECT answer FROM turn_answers WHERE question_id = ?").get(questionId)).toEqual({ answer: "maybe" });

    const turnAgent = new ScriptedAIPlayerAgent();
    turnAgent.hints.push(new Error("hint failed"));
    turnAgent.questions.push(new Error("question failed"));
    turnAgent.guesses.push(new Error("guess failed"));
    const turnValue = await fixture({ agent: turnAgent });
    const ai = turnValue.ais[0];
    const turn = makeActive(turnValue, ai.id);
    turnValue.aiRunner.reconcile(turnValue.game.id);
    for (let index = 0; index < 20 && !turnValue.turnRepo.getActiveTurn(turnValue.game.id)!.question; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    await turnValue.awaitEvaluations();
    turnValue.db.run("UPDATE questions SET answer_deadline_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = ?", [turn.turn.id]);
    await turnValue.gameService.reconcileAnswerClosure(turnValue.host.room.code, turn.turn.id, Date.now());
    turnValue.aiRunner.reconcile(turnValue.game.id);
    await drainAI(turnValue);
    expect(turnValue.db.prepare("SELECT COUNT(*) count FROM purchased_hints").get()).toEqual({ count: 0 });
    expect(turnValue.db.prepare("SELECT question_text text FROM questions WHERE turn_id = ?").get(turn.turn.id)).toEqual({ text: "Is this character human?" });
    expect(turnValue.turnRepo.getActiveTurn(turnValue.game.id)!.turn.id).not.toBe(turn.turn.id);
  });

  it("charges normal 1/2/3 costs, enforces affordability/duplicate/one-per-turn, and returns safe hints", async () => {
    expect(ECONOMY.hintCosts).toEqual({ basic: 1, series: 2, candidates: 3 });
    for (const type of ["basic", "series", "candidates"] as const) {
      const value = await fixture({ config: { ...ZERO_DELAY_CONFIG, thinkDelayMinMs: 100000, thinkDelayMaxMs: 100000 } });
      const ai = value.ais[0];
      const turn = makeActive(value, ai.id);
      value.db.run("UPDATE player_game_state SET point_balance = ? WHERE game_id = ? AND player_id = ?", [ECONOMY.hintCosts[type], value.game.id, ai.id]);
      const hint = await value.gameService.purchaseHintAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, type);
      expect(hint.cost).toBe(ECONOMY.hintCosts[type]);
      expect(JSON.stringify(hint.value)).not.toMatch(/correct|assigned_character/i);
      expect(value.db.prepare("SELECT point_balance balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(value.game.id, ai.id)).toEqual({ balance: 0 });
      await expect(value.gameService.purchaseHintAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, type)).rejects.toThrow();
      await shutdown(value.context);
      openContexts.splice(openContexts.indexOf(value.context), 1);
    }
    const value = await fixture({ config: { ...ZERO_DELAY_CONFIG, thinkDelayMinMs: 100000, thinkDelayMaxMs: 100000 } });
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id);
    await expect(value.gameService.purchaseHintAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "basic")).rejects.toThrow("Insufficient");
    expect(value.db.prepare("SELECT point_balance balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(value.game.id, ai.id)).toEqual({ balance: 0 });
  });

  it("rejects normalized duplicate wrong guesses and runner converts a repeated decision to pass", async () => {
    const agent = new ScriptedAIPlayerAgent();
    agent.guesses.push({ action: "guess", characterName: "  WRONG   NAME " });
    const value = await fixture({ agent });
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id, "awaiting_guess");
    value.db.run("INSERT INTO guess_attempts (id, game_id, player_id, turn_id, normalized_guess, display_guess, correct, attempted_at) VALUES (?, ?, ?, ?, 'wrong name', 'Wrong Name', 0, datetime('now'))", [crypto.randomUUID(), value.game.id, ai.id, turn.turn.id]);
    expect(() => value.turnRepo.submitGuessAtomic(value.game.id, ai.id, turn.turn.id, "wrong name")).toThrow("already been attempted");
    value.aiRunner.reconcile(value.game.id);
    await drainAI(value);
    expect(value.db.prepare("SELECT COUNT(*) count FROM guess_attempts WHERE game_id = ? AND player_id = ?").get(value.game.id, ai.id)).toEqual({ count: 1 });
    expect(value.turnRepo.getActiveTurn(value.game.id)!.turn.id).not.toBe(turn.turn.id);
    expect(value.db.prepare("SELECT action, outcome FROM ai_action_events WHERE game_id = ?").get(value.game.id)).toEqual({ action: "passed", outcome: "fallback" });
  });

  it("serializes active activity and last action using the frontend contract without private context", async () => {
    const value = await fixture();
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id);
    value.db.run("INSERT INTO ai_activity (game_id, player_id, turn_id, activity, updated_at) VALUES (?, ?, ?, 'thinking', '2026-01-01T00:00:00Z')", [value.game.id, ai.id, turn.turn.id]);
    value.db.run("INSERT INTO ai_action_events (game_id, player_id, turn_id, action, outcome, created_at) VALUES (?, ?, ?, 'question_asked', 'completed', '2026-01-01T00:00:01Z')", [value.game.id, ai.id, turn.turn.id]);
    const view = value.gameService.getGameViewForPlayer(value.host.room.code, value.host.player.id)!;
    expect(view.aiActivity).toEqual([{ playerId: ai.id, turnId: turn.turn.id, status: "thinking", updatedAt: "2026-01-01T00:00:00Z" }]);
    expect(view.lastAIAction).toEqual({ playerId: ai.id, turnId: turn.turn.id, action: "question_asked", outcome: "completed", createdAt: "2026-01-01T00:00:01Z" });
    expect(JSON.stringify({ aiActivity: view.aiActivity, lastAIAction: view.lastAIAction })).not.toMatch(/prompt|character|hint/i);
  });

  it("does not charge a stale deferred hint decision", async () => {
    const choice = deferred<{ action: "purchase"; type: "series" }>();
    const agent = new ScriptedAIPlayerAgent();
    agent.hints.push(choice.promise);
    const value = await fixture({ agent });
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id);
    value.db.run("UPDATE player_game_state SET point_balance = 5 WHERE game_id = ? AND player_id = ?", [value.game.id, ai.id]);
    value.aiRunner.reconcile(value.game.id);
    for (let index = 0; index < 10 && agent.hintContexts.length === 0; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    value.db.run("UPDATE game_turns SET is_active = 0, ended_at = datetime('now') WHERE id = ?", [turn.turn.id]);
    choice.resolve({ action: "purchase", type: "series" });
    await drainAI(value);
    expect(value.db.prepare("SELECT COUNT(*) count FROM purchased_hints").get()).toEqual({ count: 0 });
    expect(value.db.prepare("SELECT point_balance balance FROM player_game_state WHERE game_id = ? AND player_id = ?").get(value.game.id, ai.id)).toEqual({ balance: 5 });
  });
});

describe("Milestone 6 moderator closure policy", () => {
  it("does not busy-loop close reconciliation while moderation remains pending", async () => {
    const moderation = deferred<AnswerValue>();
    const moderator = new ScriptedModerator(moderation.promise);
    const value = await fixture({ moderator, config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id);
    await value.gameService.askQuestionAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "Pending question?");
    const questionId = value.gameService.getQuestionId(value.host.room.code, turn.turn.id);
    const evaluation = value.gameService.evaluateQuestion(questionId);
    let reconciles = 0;
    const original = value.aiRunner.reconcile.bind(value.aiRunner);
    value.aiRunner.reconcile = (gameId: string) => { reconciles++; original(gameId); };
    value.aiRunner.reconcile(value.game.id);
    let timerProgressed = false;
    await new Promise<void>((resolve) => setTimeout(() => { timerProgressed = true; resolve(); }, 10));
    expect(timerProgressed).toBe(true);
    expect(reconciles).toBe(1);
    expect(value.turnRepo.getActiveTurn(value.game.id)!.turn.phase).toBe("collecting_answers");
    moderation.resolve("yes");
    await evaluation;
    value.aiRunner.reconcile(value.game.id);
    expect(reconciles).toBe(2);
  });

  it("never closes while moderation is pending and closes after answered deadline only", async () => {
    const value = await fixture({ config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 1000 } });
    const active = value.ais[0];
    const turn = makeActive(value, active.id);
    await value.gameService.askQuestionAsAI(value.host.room.code, { kind: "ai", playerId: active.id }, turn.turn.id, "Q?");
    value.aiRunner.reconcile(value.game.id);
    await Promise.resolve();
    expect(value.turnRepo.getActiveTurn(value.game.id)!.turn.phase).toBe("collecting_answers");
    const questionId = value.gameService.getQuestionId(value.host.room.code, turn.turn.id);
    await value.gameService.evaluateQuestion(questionId);
    const deadline = Date.parse(value.turnRepo.getActiveTurn(value.game.id)!.question!.answerDeadlineAt);
    await expect(value.gameService.closeAnswersAsAI(value.host.room.code, { kind: "ai", playerId: active.id }, turn.turn.id, 1000, deadline - 1)).rejects.toThrow("deadline");
    await expect(value.gameService.closeAnswersAsAI(value.host.room.code, { kind: "ai", playerId: active.id }, turn.turn.id, 1000, deadline)).resolves.toBeDefined();
  });

  it("waits for an active deferred moderator retry before shutdown can safely close the database", async () => {
    const retry = deferred<AnswerValue>();
    const value = await fixture({ moderator: new ScriptedModerator(new Error("first"), retry.promise), config: { ...ZERO_DELAY_CONFIG, moderatorRetries: 1 } });
    const ai = value.ais[0];
    const turn = makeActive(value, ai.id);
    await value.gameService.askQuestionAsAI(value.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "Q?");
    const questionId = value.gameService.getQuestionId(value.host.room.code, turn.turn.id);
    await value.gameService.evaluateQuestion(questionId, 2);
    value.aiRunner.reconcile(value.game.id);
    while ((value.moderator as ScriptedModerator).requests.length < 2) await Promise.resolve();
    let stopped = false;
    const stopping = value.aiRunner.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    retry.resolve("yes");
    await stopping;
    expect(value.db.prepare("SELECT moderator_status status FROM questions WHERE id = ?").get(questionId)).toEqual({ status: "answered" });
    value.db.close();
    openContexts.splice(openContexts.indexOf(value.context), 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it("persists a bounded failed retry ceiling and successful retry resumes closure", async () => {
    const failed = await fixture({ moderator: new ScriptedModerator(new Error("first"), new Error("second"), "yes"), config: { ...ZERO_DELAY_CONFIG, moderatorRetries: 1 } });
    const ai = failed.ais[0];
    const turn = makeActive(failed, ai.id);
    await failed.gameService.askQuestionAsAI(failed.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "Q?");
    const questionId = failed.gameService.getQuestionId(failed.host.room.code, turn.turn.id);
    await failed.gameService.evaluateQuestion(questionId, 2);
    failed.aiRunner.reconcile(failed.game.id);
    await drainAI(failed);
    expect(failed.db.prepare("SELECT moderator_status status, moderator_attempts attempts FROM questions WHERE id = ?").get(questionId)).toEqual({ status: "failed", attempts: 2 });
    failed.aiRunner.reconcile(failed.game.id);
    await drainAI(failed);
    expect((failed.moderator as ScriptedModerator).requests).toHaveLength(2);

    const success = await fixture({ moderator: new ScriptedModerator(new Error("first"), "yes"), config: { ...ZERO_DELAY_CONFIG, moderatorRetries: 1 } });
    const successAI = success.ais[0];
    const successTurn = makeActive(success, successAI.id);
    await success.gameService.askQuestionAsAI(success.host.room.code, { kind: "ai", playerId: successAI.id }, successTurn.turn.id, "Q?");
    const successQuestion = success.gameService.getQuestionId(success.host.room.code, successTurn.turn.id);
    await success.gameService.evaluateQuestion(successQuestion, 2);
    await success.gameService.retryModerator(success.host.room.code, successAI.id, successTurn.turn.id);
    success.db.run("UPDATE questions SET answer_deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [successQuestion]);
    await success.gameService.reconcileAnswerClosure(success.host.room.code, successTurn.turn.id, Date.now());
    success.aiRunner.reconcile(success.game.id);
    await drainAI(success);
    expect(success.db.prepare("SELECT moderator_status status, moderator_attempts attempts FROM questions WHERE id = ?").get(successQuestion)).toEqual({ status: "answered", attempts: 2 });
    expect(success.turnRepo.getActiveTurn(success.game.id)!.turn.phase).not.toBe("collecting_answers");
  });
});

describe("Milestone 6 restart/reconcile and multi-AI", () => {
  it("normalizes an interrupted exhausted moderator claim and preserves one host emergency retry", async () => {
    const path = join(tmpdir(), `tebakani-m6-moderator-${crypto.randomUUID()}.sqlite`);
    files.add(path);
    const first = await fixture({ path, config: { ...ZERO_DELAY_CONFIG, moderatorRetries: 1 } });
    const ai = first.ais[0];
    const turn = makeActive(first, ai.id);
    await first.gameService.askQuestionAsAI(first.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "Interrupted question?");
    const questionId = first.gameService.getQuestionId(first.host.room.code, turn.turn.id);
    first.db.run("UPDATE questions SET moderator_attempts = 1 WHERE id = ?", [questionId]);
    expect(first.turnRepo.claimModeratorJob(questionId, false, 2)).not.toBeNull();
    expect(first.db.prepare("SELECT moderator_status status, moderator_attempts attempts, moderator_claim_token token FROM questions WHERE id = ?").get(questionId)).toMatchObject({ status: "pending", attempts: 2 });
    await shutdown(first.context);
    openContexts.splice(openContexts.indexOf(first.context), 1);

    const moderator = new ScriptedModerator("yes");
    const restarted = createApp(path, new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator, aiPlayerAgent: new ScriptedAIPlayerAgent(), aiPlayerConfig: { ...ZERO_DELAY_CONFIG, moderatorRetries: 1 }, aiRuntime: IMMEDIATE_RUNTIME });
    openContexts.push(restarted);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(restarted.db.prepare("SELECT moderator_status status, moderator_attempts attempts, moderator_claim_token token FROM questions WHERE id = ?").get(questionId)).toEqual({ status: "failed", attempts: 2, token: null });
    expect(moderator.requests).toHaveLength(0);
    await restarted.gameService.retryModerator(first.host.room.code, first.host.player.id, turn.turn.id);
    expect(moderator.requests).toHaveLength(1);
    expect(restarted.db.prepare("SELECT moderator_status status, moderator_attempts attempts FROM questions WHERE id = ?").get(questionId)).toEqual({ status: "answered", attempts: 3 });
  });

  it("restart after AI hint purchase cannot buy another hint or duplicate debit and still asks", async () => {
    const path = join(tmpdir(), `tebakani-m6-hint-${crypto.randomUUID()}.sqlite`);
    files.add(path);
    const first = await fixture({ path, config: { ...ZERO_DELAY_CONFIG, thinkDelayMinMs: 100000, thinkDelayMaxMs: 100000 } });
    const ai = first.ais[0];
    const turn = makeActive(first, ai.id);
    first.db.run("UPDATE player_game_state SET point_balance = 10 WHERE game_id = ? AND player_id = ?", [first.game.id, ai.id]);
    await first.gameService.purchaseHintAsAI(first.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, "basic");
    await shutdown(first.context);
    openContexts.splice(openContexts.indexOf(first.context), 1);
    const agent = new ScriptedAIPlayerAgent();
    agent.hints.push({ action: "purchase", type: "series" });
    agent.questions.push("Recovered question?");
    const restarted = createApp(path, new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new ScriptedModerator("yes"), aiPlayerAgent: agent, aiPlayerConfig: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 }, aiRuntime: IMMEDIATE_RUNTIME });
    openContexts.push(restarted);
    for (let index = 0; index < 30 && !restarted.turnRepo.getActiveTurn(first.game.id)!.question; index++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(restarted.db.prepare("SELECT hint_type type, cost FROM purchased_hints WHERE game_id = ?").all(first.game.id)).toEqual([{ type: "basic", cost: ECONOMY.hintCosts.basic }]);
    expect(restarted.db.prepare("SELECT amount, reason FROM point_ledger WHERE game_id = ?").all(first.game.id)).toEqual([{ amount: -ECONOMY.hintCosts.basic, reason: "hint_purchase" }]);
    expect(restarted.turnRepo.getActiveTurn(first.game.id)!.question?.questionText).toBe("Recovered question?");
    await restarted.aiRunner.stop();
  });

  it("file restart recovers waiting_for_question, missing AI answer, and awaiting_guess without duplicates", async () => {
    for (const phase of ["waiting_for_question", "collecting_answers", "awaiting_guess"] as const) {
      const path = join(tmpdir(), `tebakani-m6-${phase}-${crypto.randomUUID()}.sqlite`);
      files.add(path);
      const first = await fixture({ path, config: { ...ZERO_DELAY_CONFIG, thinkDelayMinMs: 100000, thinkDelayMaxMs: 100000, answerDelayMinMs: 100000, answerDelayMaxMs: 100000 } });
      const ai = first.ais[0];
      const active = phase === "collecting_answers" ? first.host.player.id : ai.id;
      const turn = makeActive(first, active);
      if (phase !== "waiting_for_question") {
        await askAndModerate(first, active);
        if (phase === "awaiting_guess") {
          first.db.run("UPDATE questions SET answer_deadline_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = ?", [turn.turn.id]);
          await first.gameService.closeAnswersAsAI(first.host.room.code, { kind: "ai", playerId: ai.id }, turn.turn.id, 0, Date.now());
        }
      }
      await shutdown(first.context);
      openContexts.splice(openContexts.indexOf(first.context), 1);
      const agent = new ScriptedAIPlayerAgent();
      agent.answers.push("yes");
      agent.guesses.push({ action: "pass" });
      const restarted = createApp(path, new LocalCharacterSource(COMPLETE_CHARACTERS), { moderator: new ScriptedModerator("yes"), aiPlayerAgent: agent, aiPlayerConfig: ZERO_DELAY_CONFIG, aiRuntime: IMMEDIATE_RUNTIME });
      openContexts.push(restarted);
      await drainAI(restarted);
      const questionCount = (restarted.db.prepare("SELECT COUNT(*) count FROM questions WHERE turn_id = ?").get(turn.turn.id) as { count: number }).count;
      expect(questionCount).toBeLessThanOrEqual(1);
      expect((restarted.db.prepare("SELECT COUNT(*) count FROM game_turns WHERE game_id = ? AND is_active = 1").get(first.game.id) as { count: number }).count).toBe(1);
      await shutdown(restarted);
      openContexts.splice(openContexts.indexOf(restarted), 1);
    }
  });

  it("finishes a deterministic one-human/three-AI game, skips completed AIs, and lets them keep answering", async () => {
    const value = await fixture({ aiCount: 3, moderator: new ScriptedModerator("yes"), config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
    const contexts = new AIPlayerContextRepository(value.db);
    const completed = new Set<string>();
    let completedAIAnswered = false;
    while (value.gameRepo.getGameById(value.game.id)!.status === "playing") {
      const active = value.turnRepo.getActiveTurn(value.game.id)!;
      expect(completed.has(active.turn.activePlayerId)).toBe(false);
      if (active.turn.activePlayerType === "ai") {
        const self = contexts.buildSelf(value.game.id, active.turn.activePlayerId, active.turn.id);
        const own = stateFor(value, active.turn.activePlayerId).character;
        expect(stringValues(self)).not.toContain(own.id);
        expect(stringValues(self)).not.toContain(own.name);
        await value.gameService.askQuestionAsAI(value.host.room.code, { kind: "ai", playerId: active.turn.activePlayerId }, active.turn.id, `Question ${active.turn.turnNumber}?`);
      } else {
        await value.gameService.askQuestion(value.host.room.code, active.turn.activePlayerId, active.turn.id, `Question ${active.turn.turnNumber}?`);
      }
      const questionId = value.gameService.getQuestionId(value.host.room.code, active.turn.id);
      await value.gameService.evaluateQuestion(questionId);
      for (const player of value.states.filter((entry) => entry.playerId !== active.turn.activePlayerId)) {
        if (player.playerType === "ai") {
          await value.gameService.submitAnswerAsAI(value.host.room.code, { kind: "ai", playerId: player.playerId }, active.turn.id, "yes");
          if (completed.has(player.playerId)) completedAIAnswered = true;
        } else await value.gameService.submitAnswer(value.host.room.code, player.playerId, active.turn.id, "yes");
      }
      if (active.turn.activePlayerType === "ai") await value.gameService.closeAnswersAsAI(value.host.room.code, { kind: "ai", playerId: active.turn.activePlayerId }, active.turn.id, 0, Date.now());
      else await value.gameService.closeAnswers(value.host.room.code, active.turn.activePlayerId, active.turn.id);
      const characterName = stateFor(value, active.turn.activePlayerId).character.name;
      if (active.turn.activePlayerType === "ai") await value.gameService.submitGuessAsAI(value.host.room.code, { kind: "ai", playerId: active.turn.activePlayerId }, active.turn.id, characterName);
      else await value.gameService.submitGuess(value.host.room.code, active.turn.activePlayerId, active.turn.id, characterName);
      completed.add(active.turn.activePlayerId);
    }
    expect(completed).toHaveLength(4);
    expect(completedAIAnswered).toBe(true);
    expect(value.gameRepo.getGameById(value.game.id)!.status).toBe("finished");
    expect(value.turnRepo.getActiveTurn(value.game.id)).toBeNull();
  });

  it("runs one human plus three AI with secret-safe contexts, all cross-answers, correct scoring, and circular skip", async () => {
    const agent = new ScriptedAIPlayerAgent();
    agent.answers.push("yes", "yes", "yes");
    const value = await fixture({ aiCount: 3, agent, moderator: new ScriptedModerator("yes"), config: { ...ZERO_DELAY_CONFIG, collectionDelayMs: 100000 } });
    makeActive(value, value.host.player.id);
    const { turnId, questionId } = await askAndModerate(value, value.host.player.id);
    value.aiRunner.reconcile(value.game.id);
    await drainAI(value);
    expect(value.db.prepare("SELECT COUNT(*) count FROM turn_answers WHERE question_id = ?").get(questionId)).toEqual({ count: 3 });
    for (const context of agent.answerContexts) {
      const own = stateFor(value, context.answeringPlayer.id).character;
      const values = stringValues(context);
      expect(context.target.playerId).toBe(value.host.player.id);
      expect(values).not.toContain(own.id);
      expect(values).not.toContain(own.name);
    }
    expect(value.turnRepo.getActiveTurn(value.game.id)!.turn.phase).toBe("awaiting_guess");
    expect(value.db.prepare("SELECT COUNT(*) count FROM point_ledger WHERE question_id = ? AND amount = ? AND reason = 'answer_match'").get(questionId, ECONOMY.correctAnswerPoints)).toEqual({ count: 3 });
    await value.gameService.passTurn(value.host.room.code, value.host.player.id, turnId);
    const orders = value.db.prepare("SELECT player_id id, turn_order turnOrder FROM player_game_state WHERE game_id = ? ORDER BY turn_order").all(value.game.id) as Array<{ id: string; turnOrder: number }>;
    const next = value.turnRepo.getActiveTurn(value.game.id)!;
    const currentOrder = orders.find((entry) => entry.id === value.host.player.id)!.turnOrder;
    expect(next.turn.activePlayerId).toBe(orders[(currentOrder + 1) % orders.length].id);
    value.db.run("UPDATE player_game_state SET has_guessed_correctly = 1 WHERE game_id = ? AND player_id = ?", [value.game.id, orders[(currentOrder + 2) % orders.length].id]);
    makeActive(value, orders[(currentOrder + 1) % orders.length].id, "awaiting_guess");
    await value.gameService.passTurnAsAI(value.host.room.code, { kind: "ai", playerId: orders[(currentOrder + 1) % orders.length].id }, next.turn.id);
    expect(value.turnRepo.getActiveTurn(value.game.id)!.turn.activePlayerId).toBe(orders[(currentOrder + 3) % orders.length].id);
  });
});
