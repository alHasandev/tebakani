import type { AnswerValue, CharacterSummary } from "@tebakani/shared";
import type { AIPlayerConfig, AIRuntime } from "../src/ai-player-config";
import type { AIGuessDecision, AIHintDecision, AIPlayerAgent, AIPlayerAnswerContext, AIPlayerSelfContext } from "../src/ai-player-types";

export const COMPLETE_CHARACTERS: CharacterSummary[] = Array.from({ length: 12 }, (_, index) => ({
  id: `character-${index}`,
  name: `Character ${index}`,
  series: `Series ${index % 4}`,
  description: `Distinct description ${index} without the character name`,
  imageUrl: `https://images.invalid/character-${index}.png`
}));

export const ZERO_DELAY_CONFIG: AIPlayerConfig = {
  thinkDelayMinMs: 0,
  thinkDelayMaxMs: 0,
  answerDelayMinMs: 0,
  answerDelayMaxMs: 0,
  collectionDelayMs: 0,
  gameplayRetries: 1,
  moderatorRetries: 1
};

export const IMMEDIATE_RUNTIME: AIRuntime = {
  sleep: async () => {},
  random: () => 0,
  now: () => Date.now()
};

type Script<T> = T | Error | Promise<T>;

function take<T>(queue: Script<T>[], fallback: T): Promise<T> {
  const value = queue.shift() ?? fallback;
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

export class ScriptedAIPlayerAgent implements AIPlayerAgent {
  readonly answerContexts: AIPlayerAnswerContext[] = [];
  readonly hintContexts: AIPlayerSelfContext[] = [];
  readonly questionContexts: AIPlayerSelfContext[] = [];
  readonly guessContexts: AIPlayerSelfContext[] = [];
  readonly answers: Script<AnswerValue>[] = [];
  readonly hints: Script<AIHintDecision>[] = [];
  readonly questions: Script<string>[] = [];
  readonly guesses: Script<AIGuessDecision>[] = [];

  answerQuestion(context: Readonly<AIPlayerAnswerContext>): Promise<AnswerValue> {
    this.answerContexts.push(structuredClone(context));
    return take(this.answers, "maybe");
  }

  decideHint(context: Readonly<AIPlayerSelfContext>): Promise<AIHintDecision> {
    this.hintContexts.push(structuredClone(context));
    return take(this.hints, { action: "none" });
  }

  generateQuestion(context: Readonly<AIPlayerSelfContext>): Promise<string> {
    this.questionContexts.push(structuredClone(context));
    return take(this.questions, "Is this character human?");
  }

  decideGuessOrPass(context: Readonly<AIPlayerSelfContext>): Promise<AIGuessDecision> {
    this.guessContexts.push(structuredClone(context));
    return take(this.guesses, { action: "pass" });
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

export async function drainAI(context: { awaitAI(): Promise<void> }): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await context.awaitAI();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

export async function shutdown(context: { aiRunner: { stop(): Promise<void> }; db: { close(): void } }): Promise<void> {
  await context.aiRunner.stop();
  context.db.close();
}
