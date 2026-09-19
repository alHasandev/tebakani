export interface AppEnv {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiTimeout: number;
  openaiMaxRetries: number;
  fandomBaseUrl?: string;
  fandomTimeout: number;
  fandomMaxRetries: number;
  fandomCacheTtlSeconds: number;
}

function parseInteger(name: string, value: string | undefined, minimum: number): number {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  return parsed;
}

export function loadAppEnv(env: Record<string, string | undefined> = process.env): AppEnv {
  const openaiApiKey = env.OPENAI_API_KEY?.trim();
  const openaiBaseUrl = env.OPENAI_BASE_URL?.trim();
  const openaiModel = env.OPENAI_MODEL?.trim();
  const missing = [!openaiApiKey && "OPENAI_API_KEY", !openaiBaseUrl && "OPENAI_BASE_URL", !openaiModel && "OPENAI_MODEL"].filter(Boolean);
  if (missing.length) throw new Error(`Missing required AI configuration: ${missing.join(", ")}`);

  let parsed: URL;
  try {
    parsed = new URL(openaiBaseUrl!);
  } catch {
    throw new Error("OPENAI_BASE_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("OPENAI_BASE_URL must be a valid HTTP(S) URL");

  let fandomBaseUrl: string | undefined;
  if (env.FANDOM_BASE_URL?.trim()) {
    try { const url = new URL(env.FANDOM_BASE_URL.trim()); if (url.protocol !== "https:") throw new Error(); fandomBaseUrl = url.toString().replace(/\/$/, ""); }
    catch { throw new Error("FANDOM_BASE_URL must be a valid HTTPS URL"); }
  }

  return {
    openaiApiKey: openaiApiKey!,
    openaiBaseUrl: parsed.toString().replace(/\/$/, ""),
    openaiModel: openaiModel!,
    openaiTimeout: parseInteger("OPENAI_TIMEOUT", env.OPENAI_TIMEOUT, 1),
    openaiMaxRetries: parseInteger("OPENAI_MAX_RETRIES", env.OPENAI_MAX_RETRIES, 0),
    fandomBaseUrl,
    fandomTimeout: parseInteger("FANDOM_TIMEOUT", env.FANDOM_TIMEOUT ?? "10000", 1),
    fandomMaxRetries: parseInteger("FANDOM_MAX_RETRIES", env.FANDOM_MAX_RETRIES ?? "2", 0),
    fandomCacheTtlSeconds: parseInteger("FANDOM_CACHE_TTL_SECONDS", env.FANDOM_CACHE_TTL_SECONDS ?? "604800", 1)
  };
}
