export interface AIPlayerConfig {
  thinkDelayMinMs: number;
  thinkDelayMaxMs: number;
  answerDelayMinMs: number;
  answerDelayMaxMs: number;
  collectionDelayMs: number;
  gameplayRetries: number;
  moderatorRetries: number;
}

const defaults: AIPlayerConfig = {
  thinkDelayMinMs: 1000,
  thinkDelayMaxMs: 2500,
  answerDelayMinMs: 800,
  answerDelayMaxMs: 2000,
  collectionDelayMs: 5000,
  gameplayRetries: 1,
  moderatorRetries: 1
};

function integer(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function loadAIPlayerConfig(env: Record<string, string | undefined> = process.env): AIPlayerConfig {
  const config = {
    thinkDelayMinMs: integer(env, "AI_THINK_DELAY_MIN_MS", defaults.thinkDelayMinMs),
    thinkDelayMaxMs: integer(env, "AI_THINK_DELAY_MAX_MS", defaults.thinkDelayMaxMs),
    answerDelayMinMs: integer(env, "AI_ANSWER_DELAY_MIN_MS", defaults.answerDelayMinMs),
    answerDelayMaxMs: integer(env, "AI_ANSWER_DELAY_MAX_MS", defaults.answerDelayMaxMs),
    collectionDelayMs: integer(env, "AI_COLLECTION_DELAY_MS", defaults.collectionDelayMs),
    gameplayRetries: integer(env, "AI_GAMEPLAY_RETRIES", defaults.gameplayRetries),
    moderatorRetries: integer(env, "AI_MODERATOR_RETRIES", defaults.moderatorRetries)
  };
  if (config.thinkDelayMinMs > config.thinkDelayMaxMs) throw new Error("AI_THINK_DELAY_MIN_MS must not exceed AI_THINK_DELAY_MAX_MS");
  if (config.answerDelayMinMs > config.answerDelayMaxMs) throw new Error("AI_ANSWER_DELAY_MIN_MS must not exceed AI_ANSWER_DELAY_MAX_MS");
  if (config.gameplayRetries > 1) throw new Error("AI_GAMEPLAY_RETRIES must be 0 or 1");
  return config;
}

export interface AIRuntime {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  now(): number;
}

export const defaultAIRuntime: AIRuntime = {
  sleep: (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
  random: Math.random,
  now: Date.now
};
