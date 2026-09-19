import type { CharacterSource, CharacterSummary, CharacterKnowledge } from "@tebakani/shared";
import { AnimeWikiRegistry, type WikiConfig } from "./anime-wiki-registry";
import { CharacterCache } from "./character-cache";
import { FandomClient, type WikiPage } from "./fandom-client";
import { isLikelyCharacterPage, sanitizeCharacter, sanitizeExternalText, sanitizeStringArray } from "./character-sanitize";
import { characterIdentityKeys, uniqueCharacters } from "./character-identity";

export interface CharacterSourceLogger { info(event: string, fields?: Record<string, string | number | boolean>): void; warn(event: string, fields?: Record<string, string | number | boolean>): void }
const quietLogger: CharacterSourceLogger = { info() {}, warn() {} };
const INFOBOX_KEYS: Record<string, keyof CharacterKnowledge> = { alias: "aliases", aliases: "aliases", nickname: "aliases", nicknames: "aliases", "romanized name": "aliases", "japanese name": "aliases", gender: "gender", species: "species", affiliation: "affiliations", affiliations: "affiliations", ability: "abilities", abilities: "abilities", occupation: "occupation", status: "status" };

function splitInfoboxValue(value: string): string[] {
  const links: string[] = [];
  const protectedValue = value.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, display?: string) => {
    links.push(display?.trim() || target.trim());
    return `\u0000${links.length - 1}\u0000`;
  }).replace(/<br\s*\/?>/gi, "|");
  return protectedValue.split(/\s*(?:\||,|;|\/\/)\s*/).map((part) => part.replace(/\u0000(\d+)\u0000/g, (_match, index) => links[Number(index)] ?? ""));
}

function parseInfobox(wikitext: string): CharacterKnowledge {
  const values: Record<string, string[]> = {};
  for (const line of wikitext.slice(0, 50000).split(/\r?\n/)) {
    const match = /^\s*\|\s*([^=]{1,40})\s*=\s*(.{1,1000})\s*$/.exec(line);
    if (!match) continue;
    const key = match[1].normalize("NFKC").trim().toLocaleLowerCase().replace(/[_-]+/g, " ");
    const target = INFOBOX_KEYS[key];
    if (!target) continue;
    values[target] ??= [];
    values[target].push(...splitInfoboxValue(match[2]));
  }
  return {
    aliases: sanitizeStringArray(values.aliases),
    gender: sanitizeExternalText(values.gender?.[0], 60) || undefined,
    species: sanitizeExternalText(values.species?.[0], 100) || undefined,
    affiliations: sanitizeStringArray(values.affiliations),
    abilities: sanitizeStringArray(values.abilities),
    occupation: sanitizeStringArray(values.occupation),
    status: sanitizeExternalText(values.status?.[0], 80) || undefined
  };
}
function normalizePage(config: WikiConfig, page: WikiPage): CharacterSummary | null {
  const name = sanitizeExternalText(page.title.replace(/\s*\([^)]*\)\s*$/, ""), 120);
  const description = sanitizeExternalText(page.extract, 1600);
  const parsed = parseInfobox(page.wikitext);
  const aliases = sanitizeStringArray([...(parsed.aliases ?? []), ...page.redirects]).filter((alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
  const knowledge = { ...parsed, aliases, notableTraits: description ? [description.slice(0, 300)] : [] };
  if (!name || (!description && !Object.values(knowledge).some((value) => Array.isArray(value) ? value.length : Boolean(value)))) return null;
  return sanitizeCharacter({ id: `fandom:${config.key}:${page.pageId}`, name, series: config.series, imageUrl: page.imageUrl, description, source: "fandom", sourceKey: config.key, sourceUrl: page.pageUrl, knowledge });
}
function addUnique(characters: CharacterSummary[], character: CharacterSummary) {
  const known = new Set(characters.flatMap(characterIdentityKeys));
  if (characterIdentityKeys(character).some((key) => known.has(key))) return;
  characters.push(character);
}

export interface FandomSourceOptions { operationBudgetMs?: number; maxSeedAttempts?: number; maxConsecutiveFailures?: number }
export class FandomCharacterSource implements CharacterSource {
  private loads = new Map<string, Promise<CharacterSummary | null>>();
  private readonly operationBudgetMs: number;
  private readonly maxSeedAttempts: number;
  private readonly maxConsecutiveFailures: number;
  constructor(private registry: AnimeWikiRegistry, private client: FandomClient, private cache: CharacterCache, private random: () => number = Math.random, private logger: CharacterSourceLogger = quietLogger, options: FandomSourceOptions = {}) {
    this.operationBudgetMs = Math.max(100, options.operationBudgetMs ?? 2500);
    this.maxSeedAttempts = Math.max(0, options.maxSeedAttempts ?? 4);
    this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? 2);
  }
  async getCharacterById(id: string) { const match = /^fandom:([^:]+):(\d+)$/.exec(id); if (!match) return null; const config = this.registry.lookupKey(match[1]); if (!config) { this.logger.warn("registry_lookup_miss", { key: match[1] }); return null; } return this.load(config, Number(match[2])); }
  async getCharactersBySeries(series: string, count: number) { const config = this.registry.lookupSeries(series); if (!config) return []; return this.poolFor(config, count); }
  async searchCharacters(query: string, options: { series?: string; limit?: number } = {}) {
    const configs = options.series ? [this.registry.lookupSeries(options.series)].filter((value): value is WikiConfig => Boolean(value)) : this.registry.list();
    const limit = Math.min(20, Math.max(1, options.limit ?? 10)); const results: CharacterSummary[] = [];
    for (const config of configs) { try { for (const hit of await this.client.search(config.baseUrl, query, limit)) { const character = await this.load(config, hit.pageId); if (character) addUnique(results, character); if (results.length >= limit) return results; } } catch { this.logger.warn("provider_error", { key: config.key }); } }
    return results;
  }
  async getRandomCharacters(count: number) {
    const deadline = Date.now() + this.operationBudgetMs;
    const unique: CharacterSummary[] = [];
    const cached = this.shuffle(this.cache.list());
    for (const entry of cached) {
      const config = this.registry.lookupKey(entry.sourceKey);
      if (!entry.expired) addUnique(unique, entry.character);
      else if (config && Date.now() < deadline) {
        const character = await this.withDeadline(this.load(config, entry.pageId), deadline, entry.character);
        if (character) addUnique(unique, character);
      } else addUnique(unique, entry.character);
    }
    const target = Math.min(24, Math.max(count, 12, count * 3));
    const seeds = this.shuffle(this.registry.list().flatMap((config) => config.seedTitles.map((title) => ({ config, title }))));
    let attempts = 0; let failures = 0;
    for (const seed of seeds) {
      if (unique.length >= target || attempts >= this.maxSeedAttempts || failures >= this.maxConsecutiveFailures || Date.now() >= deadline) break;
      attempts++;
      try { const hit = (await this.withDeadline(this.client.search(seed.config.baseUrl, seed.title, 1), deadline, []))[0]; if (!hit) continue; const character = await this.withDeadline(this.load(seed.config, hit.pageId), deadline, null); if (character) { addUnique(unique, character); failures = 0; } }
      catch { failures++; this.logger.warn("provider_error", { key: seed.config.key }); }
    }
    return this.shuffle(unique).slice(0, count);
  }
  private async poolFor(config: WikiConfig, count: number) {
    const deadline = Date.now() + this.operationBudgetMs;
    const unique: CharacterSummary[] = [];
    for (const entry of this.cache.list(config.key)) {
      const character = entry.expired && Date.now() < deadline ? await this.withDeadline(this.load(config, entry.pageId), deadline, entry.character) : entry.character;
      if (character) addUnique(unique, character);
    }
    const target = Math.min(20, Math.max(count, 8));
    let attempts = 0; let failures = 0;
    for (const title of config.seedTitles) {
      if (unique.length >= target || attempts >= this.maxSeedAttempts || failures >= this.maxConsecutiveFailures || Date.now() >= deadline) break;
      attempts++;
      try { const hit = (await this.withDeadline(this.client.search(config.baseUrl, title, 1), deadline, []))[0]; if (hit) { const character = await this.withDeadline(this.load(config, hit.pageId), deadline, null); if (character) { addUnique(unique, character); failures = 0; } } }
      catch { failures++; this.logger.warn("provider_error", { key: config.key }); }
    }
    return this.shuffle(unique).slice(0, count);
  }
  private async withDeadline<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fallback;
    return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), remaining))]);
  }
  private load(config: WikiConfig, pageId: number) { const key = `${config.key}:${pageId}`; const existing = this.loads.get(key); if (existing) return existing; const promise = this.loadOnce(config, pageId).finally(() => this.loads.delete(key)); this.loads.set(key, promise); return promise; }
  private async loadOnce(config: WikiConfig, pageId: number) { const cached = this.cache.get(config.key, pageId); if (cached && !cached.expired) { this.logger.info("cache_hit", { key: config.key }); return cached.character; } this.logger.info(cached ? "cache_refresh" : "cache_miss", { key: config.key }); try { const page = await this.client.getPage(config.baseUrl, pageId); if (!page || !isLikelyCharacterPage(page.title, page.categories, page.namespace)) return null; const character = normalizePage(config, page); if (!character) return null; this.cache.put(config.key, pageId, character, page); return character; } catch { if (cached) { this.logger.warn("stale_fallback", { key: config.key }); return cached.character; } throw new Error("Character provider unavailable"); } }
  private shuffle<T>(values: T[]) { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
}

export class LayeredCharacterSource implements CharacterSource {
  constructor(private primary: CharacterSource, private fallback: CharacterSource, private logger: CharacterSourceLogger = quietLogger) {}
  async getCharacterById(id: string) { try { return await this.primary.getCharacterById(id) ?? await this.fallback.getCharacterById(id); } catch { this.logger.warn("local_fallback"); return this.fallback.getCharacterById(id); } }
  async getRandomCharacters(count: number) { let primary: CharacterSummary[] = []; try { primary = uniqueCharacters(await this.primary.getRandomCharacters(count)); } catch { this.logger.warn("local_fallback"); } if (primary.length >= count) return primary.slice(0, count); const local = await this.availableRandom(this.fallback, count, count - primary.length); return this.merge(primary, local).slice(0, count); }
  async getCharactersBySeries(series: string, count: number) { let primary: CharacterSummary[] = []; try { primary = uniqueCharacters(await this.primary.getCharactersBySeries?.(series, count) ?? []); } catch { this.logger.warn("local_fallback"); } if (primary.length >= count) return primary.slice(0, count); const local = await this.availableBySeries(this.fallback, series, count, count - primary.length); return this.merge(primary, local).slice(0, count); }
  async searchCharacters(query: string, options: { series?: string; limit?: number } = {}) { const limit = Math.min(20, Math.max(1, options.limit ?? 10)); let primary: CharacterSummary[] = []; try { primary = await this.primary.searchCharacters?.(query, { ...options, limit }) ?? []; } catch { this.logger.warn("local_fallback"); } const local = primary.length < limit ? await this.fallback.searchCharacters?.(query, { ...options, limit }) ?? [] : []; return this.merge(primary, local).slice(0, limit); }
  private async availableRandom(source: CharacterSource, preferred: number, minimum: number) { for (let count = preferred; count >= minimum; count--) { try { return await source.getRandomCharacters(count); } catch {} } return []; }
  private async availableBySeries(source: CharacterSource, series: string, preferred: number, minimum: number) { if (!source.getCharactersBySeries) return []; for (let count = preferred; count >= minimum; count--) { try { return await source.getCharactersBySeries(series, count); } catch {} } return []; }
  private merge(...groups: CharacterSummary[][]) { return uniqueCharacters(groups.flat()); }
}
