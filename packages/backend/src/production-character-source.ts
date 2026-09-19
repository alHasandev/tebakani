import type { Database } from "bun:sqlite";
import type { CharacterSource } from "@tebakani/shared";
import { AnimeWikiRegistry } from "./anime-wiki-registry";
import { CharacterCache } from "./character-cache";
import { LocalCharacterSource } from "./character-source";
import { FandomCharacterSource, LayeredCharacterSource } from "./fandom-character-source";
import { FandomClient } from "./fandom-client";

function integer(name: string, value: string | undefined, fallback: number, minimum: number) { const raw = value?.trim() || String(fallback); if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer greater than or equal to ${minimum}`); const parsed = Number(raw); if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer greater than or equal to ${minimum}`); return parsed; }

export function createCharacterSource(db: Database, env: Record<string, string | undefined> = process.env): CharacterSource {
  const local = new LocalCharacterSource();
  const configured = env.FANDOM_BASE_URL?.trim();
  if (!configured) return local;
  let url: URL; try { url = new URL(configured); } catch { throw new Error("FANDOM_BASE_URL must be a valid HTTPS URL"); }
  if (url.protocol !== "https:") throw new Error("FANDOM_BASE_URL must be a valid HTTPS URL");
  const timeout = integer("FANDOM_TIMEOUT", env.FANDOM_TIMEOUT, 10000, 1);
  const retries = integer("FANDOM_MAX_RETRIES", env.FANDOM_MAX_RETRIES, 2, 0);
  const ttl = integer("FANDOM_CACHE_TTL_SECONDS", env.FANDOM_CACHE_TTL_SECONDS, 604800, 1);
  const registry = new AnimeWikiRegistry(undefined, url.toString());
  const fandom = new FandomCharacterSource(registry, new FandomClient({ timeoutMs: timeout, maxRetries: retries }), new CharacterCache(db, ttl));
  return new LayeredCharacterSource(fandom, local);
}
