import type { AnswerValue } from "@tebakani/shared";
import type { GameRepository } from "./game-repository";
import type { TurnRepository } from "./turn-repository";
import type { GameService } from "./game-service";
import type { AIPlayerContextRepository } from "./ai-player-context";
import type { AIPlayerAgent } from "./ai-player-types";
import type { AIPlayerConfig, AIRuntime } from "./ai-player-config";
import type { AIActivityRepository } from "./ai-activity";

export interface AIPlayerRunnerHooks {
  stateChanged?(roomCode: string, finished?: boolean): void;
  evaluateQuestion?(roomCode: string, questionId: string): void;
}

export class AIPlayerRunner {
  private tasks = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private stopped = false;

  constructor(private gameRepo: GameRepository, private turnRepo: TurnRepository, private gameService: GameService, private contexts: AIPlayerContextRepository, private activity: AIActivityRepository, private agent: AIPlayerAgent, private config: AIPlayerConfig, private runtime: AIRuntime, private hooks: AIPlayerRunnerHooks = {}) {}

  reconcileAll(): void { for (const item of this.turnRepo.listActiveGames()) this.reconcile(item.gameId); }

  reconcile(gameId: string): void {
    if (this.stopped) return;
    const state = this.turnRepo.getActiveTurn(gameId);
    const game = this.gameRepo.getGameById(gameId);
    if (!state || !game || game.status !== "playing") return;
    if (state.turn.phase === "collecting_answers" && state.question) {
      for (const playerId of this.turnRepo.listMissingAIAnswerers(gameId, state.turn.id)) this.run(`answer:${state.question.id}:${playerId}`, (signal) => this.answer(game.roomCode, gameId, state.turn.id, playerId, signal));
      if (state.turn.activePlayerType === "ai") {
        const collection = this.turnRepo.getCollectionState(gameId, state.turn.id);
        const key = `close:${state.question.id}`;
        if (collection && collection.answeredCount >= collection.eligibleCount) this.cancel(key);
        if (!collection || collection.moderatorStatus !== "failed" || collection.moderatorAttempts < this.config.moderatorRetries + 1) this.run(key, (signal) => this.close(game.roomCode, gameId, state.turn.id, signal), () => {
          const latest = this.turnRepo.getCollectionState(gameId, state.turn.id);
          if (latest?.moderatorStatus !== "pending") this.reconcile(gameId);
        });
      }
    }
    if (state.turn.activePlayerType !== "ai") return;
    if (state.turn.phase === "waiting_for_question") this.run(`turn:${state.turn.id}:question`, (signal) => this.ask(game.roomCode, gameId, state.turn.id, state.turn.activePlayerId, signal));
    if (state.turn.phase === "awaiting_guess") this.run(`turn:${state.turn.id}:guess`, (signal) => this.guess(game.roomCode, gameId, state.turn.id, state.turn.activePlayerId, signal));
  }

  async drain(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks.values()]); }
  async stop(): Promise<void> { this.stopped = true; for (const controller of this.controllers.values()) controller.abort(); await this.drain(); }

  private cancel(key: string): void { this.controllers.get(key)?.abort(); }
  private run(key: string, work: (signal: AbortSignal) => Promise<void>, after?: () => void): void {
    if (this.tasks.has(key) || this.stopped) return;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const task = work(controller.signal).catch(() => {}).finally(() => { if (this.controllers.get(key) === controller) this.controllers.delete(key); this.tasks.delete(key); if (!this.stopped) after?.(); });
    this.tasks.set(key, task);
  }

  private async wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.stopped) return false;
    await Promise.race([this.runtime.sleep(ms, signal), new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    return !signal.aborted && !this.stopped;
  }
  private delay(min: number, max: number, signal: AbortSignal): Promise<boolean> { return this.wait(min + Math.floor(this.runtime.random() * (max - min + 1)), signal); }
  private changed(roomCode: string, gameId: string, finished = false): void { this.hooks.stateChanged?.(roomCode, finished); if (!this.stopped) queueMicrotask(() => this.reconcile(gameId)); }

  private async answer(code: string, gameId: string, turnId: string, playerId: string, signal: AbortSignal): Promise<void> {
    this.activity.set(gameId, playerId, turnId, "answering"); this.hooks.stateChanged?.(code);
    try {
      if (!await this.delay(this.config.answerDelayMinMs, this.config.answerDelayMaxMs, signal)) return;
      let answer: AnswerValue = "maybe";
      try { answer = await this.agent.answerQuestion(this.contexts.buildAnswer(gameId, playerId, turnId), signal); } catch {}
      if (signal.aborted || this.stopped) return;
      await this.gameService.submitAnswerAsAI(code, { kind: "ai", playerId }, turnId, answer);
      this.activity.record(gameId, playerId, turnId, "answered", answer === "maybe" ? "fallback" : "completed");
      this.changed(code, gameId);
    } catch {} finally { this.activity.clear(gameId, playerId, turnId); this.hooks.stateChanged?.(code); }
  }

  private async ask(code: string, gameId: string, turnId: string, playerId: string, signal: AbortSignal): Promise<void> {
    this.activity.set(gameId, playerId, turnId, "thinking"); this.hooks.stateChanged?.(code);
    try {
      if (!await this.delay(this.config.thinkDelayMinMs, this.config.thinkDelayMaxMs, signal)) return;
      let context = this.contexts.buildSelf(gameId, playerId, turnId);
      try {
        this.activity.set(gameId, playerId, turnId, "choosing_hint"); this.hooks.stateChanged?.(code);
        const hint = await this.agent.decideHint(context, signal);
        if (signal.aborted || this.stopped) return;
        if (hint.action === "purchase") { await this.gameService.purchaseHintAsAI(code, { kind: "ai", playerId }, turnId, hint.type); this.activity.record(gameId, playerId, turnId, "hint_purchased", "completed"); this.changed(code, gameId); }
      } catch {}
      if (signal.aborted || this.stopped) return;
      context = this.contexts.buildSelf(gameId, playerId, turnId);
      this.activity.set(gameId, playerId, turnId, "asking"); this.hooks.stateChanged?.(code);
      let question = "Is this character primarily known for fighting?";
      try { question = await this.agent.generateQuestion(context, signal); } catch {
        const used = new Set(context.evidence.map((entry) => entry.question.toLocaleLowerCase()));
        question = ["Is this character human?", "Does this character have supernatural abilities?", "Is this character an adult?"].find((item) => !used.has(item.toLocaleLowerCase())) ?? `Is this character from a series with action elements (${context.game.turnNumber})?`;
      }
      if (signal.aborted || this.stopped) return;
      await this.gameService.askQuestionAsAI(code, { kind: "ai", playerId }, turnId, question);
      this.activity.record(gameId, playerId, turnId, "question_asked", "completed");
      const questionId = this.gameService.getQuestionId(code, turnId);
      this.changed(code, gameId);
      this.hooks.evaluateQuestion?.(code, questionId);
    } catch {} finally { this.activity.clear(gameId, playerId, turnId); this.hooks.stateChanged?.(code); }
  }

  private async close(code: string, gameId: string, turnId: string, signal: AbortSignal): Promise<void> {
    const state = this.turnRepo.getCollectionState(gameId, turnId);
    if (!state) return;
    if (state.moderatorStatus === "failed") {
      if (state.moderatorAttempts >= this.config.moderatorRetries + 1) return;
      try { await this.gameService.retryModerator(code, state.activePlayerId, turnId); this.hooks.stateChanged?.(code); } catch {}
      if (!signal.aborted && !this.stopped) this.reconcile(gameId);
      return;
    }
    if (state.moderatorStatus !== "answered") return;
    const elapsed = Math.max(0, this.runtime.now() - Date.parse(state.askedAt));
    if (state.answeredCount < state.eligibleCount && elapsed < this.config.collectionDelayMs && !await this.wait(this.config.collectionDelayMs - elapsed, signal)) return;
    if (signal.aborted || this.stopped) return;
    try { await this.gameService.closeAnswersAsAI(code, { kind: "ai", playerId: state.activePlayerId }, turnId, this.config.collectionDelayMs, this.runtime.now()); this.changed(code, gameId); } catch {}
  }

  private async guess(code: string, gameId: string, turnId: string, playerId: string, signal: AbortSignal): Promise<void> {
    this.activity.set(gameId, playerId, turnId, "guessing"); this.hooks.stateChanged?.(code);
    try {
      if (!await this.delay(this.config.thinkDelayMinMs, this.config.thinkDelayMaxMs, signal)) return;
      let decision: Awaited<ReturnType<AIPlayerAgent["decideGuessOrPass"]>> = { action: "pass" };
      try { decision = await this.agent.decideGuessOrPass(this.contexts.buildSelf(gameId, playerId, turnId), signal); } catch {}
      if (signal.aborted || this.stopped) return;
      if (decision.action === "guess") {
        const normalized = decision.characterName.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
        if (this.contexts.getWrongGuesses(gameId, playerId).includes(normalized)) {
          await this.gameService.passTurnAsAI(code, { kind: "ai", playerId }, turnId);
          this.activity.record(gameId, playerId, turnId, "passed", "fallback"); this.changed(code, gameId);
          return;
        }
        const result = await this.gameService.submitGuessAsAI(code, { kind: "ai", playerId }, turnId, decision.characterName);
        this.activity.record(gameId, playerId, turnId, "guessed", result.correct ? "correct" : "incorrect"); this.changed(code, gameId, result.isFinished);
      } else {
        await this.gameService.passTurnAsAI(code, { kind: "ai", playerId }, turnId);
        this.activity.record(gameId, playerId, turnId, "passed", "completed"); this.changed(code, gameId);
      }
    } catch {
      if (!signal.aborted && !this.stopped) try { await this.gameService.passTurnAsAI(code, { kind: "ai", playerId }, turnId); this.activity.record(gameId, playerId, turnId, "passed", "fallback"); this.changed(code, gameId); } catch {}
    } finally { this.activity.clear(gameId, playerId, turnId); this.hooks.stateChanged?.(code); }
  }
}
