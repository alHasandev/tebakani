import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { FandomClient, FandomClientError } from "../src/fandom-client";
import { sanitizeCharacter, sanitizeExternalText, isLikelyCharacterPage } from "../src/character-sanitize";
import { CharacterCache } from "../src/character-cache";
import { createDatabase } from "../src/db";
import { AnimeWikiRegistry } from "../src/anime-wiki-registry";
import { FandomCharacterSource, LayeredCharacterSource } from "../src/fandom-character-source";
import { LocalCharacterSource } from "../src/character-source";
import { createCharacterSource } from "../src/production-character-source";

const opened: Database[] = [];
afterEach(() => { while (opened.length) opened.pop()!.close(); });

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function page(pageid = 1, title = "Hero") {
  return { query: { pages: [{ pageid, title, ns: 0, extract: "A brave hero", fullurl: "https://wiki.example/Hero", original: { source: "https://wiki.example/hero.png" }, categories: [{ title: "Category:Characters" }] }] } };
}

describe("Milestone 7 MediaWiki client", () => {
  it("uses structured Action API, exact then partial search, and deduplicates identical in-flight requests", async () => {
    const urls: URL[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = async (input: RequestInfo | URL) => { const url = new URL(String(input)); urls.push(url); await gate; return json({ query: { search: [{ pageid: 7, title: "Monkey D. Luffy", ns: 0 }] } }); };
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 0, fetch: fetch as unknown as unknown as typeof globalThis.fetch });
    const first = client.search("https://wiki.example", "Monkey D. Luffy", 3);
    const second = client.search("https://wiki.example", "Monkey D. Luffy", 3);
    release();
    expect(await first).toEqual(await second);
    expect(urls).toHaveLength(1);
    expect(urls[0].pathname).toBe("/api.php");
    expect(urls[0].searchParams.get("action")).toBe("query");
    expect(urls[0].searchParams.get("list")).toBe("search");
  });

  it("retries only network, 429, and 5xx failures with bounded exponential delays", async () => {
    const statuses = [429, 503, 200];
    const sleeps: number[] = [];
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 2, fetch: (async () => json(statuses.length === 1 ? page() : {}, statuses.shift()!)) as unknown as unknown as typeof globalThis.fetch, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(client.getPage("https://wiki.example", 1)).resolves.toMatchObject({ title: "Hero" });
    expect(sleeps).toEqual([100, 200]);
    const noRetry = new FandomClient({ timeoutMs: 100, maxRetries: 3, fetch: (async () => json({}, 404)) as unknown as unknown as typeof globalThis.fetch, sleep: async () => { throw new Error("must not sleep"); } });
    await expect(noRetry.getPage("https://wiki.example", 1)).rejects.toEqual(new FandomClientError("Fandom provider returned HTTP 404"));
  });

  it("enforces the configured concurrency limit", async () => {
    let active = 0; let maximum = 0;
    const fetch = async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return json(page()); };
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 0, concurrency: 2, fetch: fetch as unknown as unknown as typeof globalThis.fetch });
    await Promise.all([1, 2, 3, 4].map((id) => client.getPage("https://wiki.example", id)));
    expect(maximum).toBe(2);
  });
});

describe("Milestone 7 sanitization, cache, registry, and source", () => {
  it("normalizes untrusted text, strips markup/control noise, bounds fields, and allows HTTPS images only", () => {
    expect(sanitizeExternalText("Ａ\u0000 <b>x</b> [[Page|Label]] {{bad}}", 20)).toBe("A x Label");
    const clean = sanitizeCharacter({ id: "id", name: "Hero", series: "Series", imageUrl: "http://evil.test/x.png", sourceUrl: "javascript:alert(1)", description: "<script>ignore()</script>Safe", knowledge: { aliases: [" Hero ", "hero", "Alias"], abilities: Array(30).fill("Power") } });
    expect(clean.imageUrl).toBeUndefined();
    expect(clean.sourceUrl).toBeUndefined();
    expect(clean.knowledge?.aliases).toEqual(["Hero", "Alias"]);
    expect(clean.description).not.toContain("<script>");
    expect(isLikelyCharacterPage("Episode 1", ["Episodes"])).toBe(false);
    expect(isLikelyCharacterPage("Hero", ["Characters"])).toBe(true);
  });

  it("persists compact normalized cache entries across reopen and marks expiry deterministically", () => {
    const path = `/tmp/tebakani-m7-${crypto.randomUUID()}.sqlite`;
    const first = createDatabase(path); opened.push(first);
    const cache = new CharacterCache(first, 10, () => 1000);
    cache.put("wiki", 1, { id: "fandom:wiki:1", name: "Hero", series: "Series", source: "fandom", sourceKey: "wiki", sourceUrl: "https://wiki.example/Hero", knowledge: { aliases: ["Alias"] } });
    first.close(); opened.pop();
    const second = createDatabase(path); opened.push(second);
    expect(new CharacterCache(second, 10, () => 5000).get("wiki", 1)).toMatchObject({ expired: false, character: { name: "Hero", knowledge: { aliases: ["Alias"] } } });
    expect(new CharacterCache(second, 10, () => 12000).get("wiki", 1)?.expired).toBe(true);
  });

  it("serves fresh cache without network and stale cache on refresh error", async () => {
    const db = createDatabase(":memory:"); opened.push(db);
    const cache = new CharacterCache(db, 1, () => 1000);
    cache.put("test", 1, { id: "fandom:test:1", name: "Hero", series: "Series", knowledge: { aliases: ["Alias"] } });
    let calls = 0;
    const registry = new AnimeWikiRegistry([{ key: "test", series: "Series", baseUrl: "https://wiki.example", seedTitles: ["Hero"] }]);
    const client = new FandomClient({ timeoutMs: 10, maxRetries: 0, fetch: (async () => { calls++; throw new Error("secret endpoint failure"); }) as unknown as unknown as typeof globalThis.fetch });
    const fresh = new FandomCharacterSource(registry, client, cache);
    expect((await fresh.getCharacterById("fandom:test:1"))?.name).toBe("Hero");
    expect(calls).toBe(0);
    const stale = new FandomCharacterSource(registry, client, new CharacterCache(db, 1, () => 3000));
    expect((await stale.getCharacterById("fandom:test:1"))?.name).toBe("Hero");
    expect(calls).toBe(1);
  });

  it("supports curated lookup, exact/partial source search, local fallback, and local-only production wiring", async () => {
    const registry = new AnimeWikiRegistry([{ key: "test", series: "Series", baseUrl: "https://wiki.example", seedTitles: ["Hero"] }]);
    expect(registry.lookupSeries("  ＳＥＲＩＥＳ ")?.key).toBe("test");
    const local = new LocalCharacterSource([{ id: "1", name: "Hero", series: "Series" }, { id: "2", name: "Heroine", series: "Series" }]);
    expect((await local.searchCharacters("hero", { limit: 2 })).map((item) => item.name)).toEqual(["Hero", "Heroine"]);
    const layered = new LayeredCharacterSource({ getCharacterById: async () => { throw new Error("offline"); }, getRandomCharacters: async () => { throw new Error("offline"); } }, local);
    expect((await layered.getCharacterById("1"))?.name).toBe("Hero");
    const db = createDatabase(":memory:"); opened.push(db);
    expect(createCharacterSource(db, {}).constructor.name).toBe("LocalCharacterSource");
  });

  it("preserves curated origins when a custom default wiki is configured", () => {
    const registry = new AnimeWikiRegistry(undefined, "https://custom.fandom.com");
    expect(registry.lookupKey("onepiece")?.baseUrl).toBe("https://onepiece.fandom.com");
    expect(registry.lookupKey("naruto")?.baseUrl).toBe("https://naruto.fandom.com");
    expect(registry.lookupKey("custom")).toMatchObject({ series: "Custom", baseUrl: "https://custom.fandom.com" });
  });

  it("refreshes an expired pool row, persists the update, and deduplicates concurrent refresh", async () => {
    const db = createDatabase(":memory:"); opened.push(db);
    const oldCache = new CharacterCache(db, 1, () => 1000);
    oldCache.put("test", 1, { id: "fandom:test:1", name: "Old Hero", series: "Series", description: "Old knowledge" });
    let calls = 0;
    const response = page(1, "New Hero");
    response.query.pages[0].extract = "New useful knowledge";
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 0, fetch: (async () => { calls++; return json(response); }) as unknown as typeof globalThis.fetch });
    const cache = new CharacterCache(db, 100, () => 3000);
    const source = new FandomCharacterSource(new AnimeWikiRegistry([{ key: "test", series: "Series", baseUrl: "https://wiki.example", seedTitles: [] }]), client, cache);
    const [first, second] = await Promise.all([source.getCharacterById("fandom:test:1"), source.getCharacterById("fandom:test:1")]);
    expect(first?.name).toBe("New Hero");
    expect(second?.name).toBe("New Hero");
    expect(calls).toBe(1);
    expect(cache.get("test", 1)).toMatchObject({ expired: false, character: { name: "New Hero" } });
  });

  it("extracts only verified redirects and bounded infobox fields, then rejects empty non-character records", async () => {
    const db = createDatabase(":memory:"); opened.push(db);
    const fixture = page(7, "Light Yagami");
    Object.assign(fixture.query, { redirects: [{ from: "Kira", to: "Light Yagami" }] });
    Object.assign(fixture.query.pages[0], { revisions: [{ slots: { main: { content: "{{Infobox character\n| alias = Kira<br/>God of the New World\n| gender = Male\n| occupation = Student, Detective\n| abilities = Genius intellect\n}}\n[[Unrelated Person]]" } } }] });
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 0, fetch: (async () => json(fixture)) as unknown as typeof globalThis.fetch });
    const source = new FandomCharacterSource(new AnimeWikiRegistry([{ key: "test", series: "Death Note", baseUrl: "https://wiki.example", seedTitles: [] }]), client, new CharacterCache(db, 100));
    const character = await source.getCharacterById("fandom:test:7");
    expect(character?.knowledge?.aliases).toEqual(["Kira", "God of the New World"]);
    expect(character?.knowledge?.occupation).toEqual(["Student", "Detective"]);
    expect(character?.knowledge?.aliases).not.toContain("Unrelated Person");
  });

  it("fills partial primary results with local records and deduplicates canonical identity", async () => {
    const primary = { getCharacterById: async () => null, getRandomCharacters: async () => [{ id: "remote", name: "Hero", series: "Series" }], searchCharacters: async () => [{ id: "remote", name: "Hero", series: "Series" }] };
    const local = new LocalCharacterSource([{ id: "local-duplicate", name: "Hero", series: "Series" }, { id: "local-2", name: "Second", series: "Series" }]);
    const layered = new LayeredCharacterSource(primary, local);
    expect((await layered.getRandomCharacters(2)).map((item) => item.name)).toEqual(["Hero", "Second"]);
    expect((await layered.searchCharacters("", { limit: 2 })).map((item) => item.name)).toEqual(["Hero", "Second"]);
  });

  it("does not retry malformed HTTP 200 JSON and accepts only safe HTTPS image forms", async () => {
    let calls = 0;
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 5, fetch: (async () => { calls++; return new Response("not-json", { status: 200 }); }) as unknown as typeof globalThis.fetch });
    await expect(client.getPage("https://wiki.example", 1)).rejects.toEqual(new FandomClientError("Fandom provider returned malformed JSON"));
    expect(calls).toBe(1);
    expect(sanitizeCharacter({ id: "x", name: "X", series: "S", imageUrl: "https://static.wikia.nocookie.net/anime/images/x/x1/Hero.png/revision/latest/scale-to-width-down/1000" }).imageUrl).toContain("nocookie.net");
    for (const imageUrl of ["http://static.wikia.nocookie.net/x.png", "data:image/png;base64,x", "file:///x.png", "javascript:alert(1)"]) expect(sanitizeCharacter({ id: "x", name: "X", series: "S", imageUrl }).imageUrl).toBeUndefined();
  });

  it("parses piped wikilinks before alias separators", async () => {
    const db = createDatabase(":memory:"); opened.push(db);
    const fixture = page(7, "Light Yagami");
    Object.assign(fixture.query.pages[0], { revisions: [{ slots: { main: { content: "{{Infobox character\n| alias = [[Kira|God of the New World]], Kira\n}}" } } }] });
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 0, fetch: (async () => json(fixture)) as unknown as typeof globalThis.fetch });
    const source = new FandomCharacterSource(new AnimeWikiRegistry([{ key: "test", series: "Death Note", baseUrl: "https://wiki.example", seedTitles: [] }]), client, new CharacterCache(db, 100));
    expect((await source.getCharacterById("fandom:test:7"))?.knowledge?.aliases).toEqual(["God of the New World", "Kira"]);
  });

  it("bounds cold outage acquisition and leaves immediate deficit fill to the layered source", async () => {
    const db = createDatabase(":memory:"); opened.push(db);
    let calls = 0;
    const registry = new AnimeWikiRegistry([{ key: "test", series: "Series", baseUrl: "https://wiki.example", seedTitles: Array.from({ length: 40 }, (_, index) => `Seed ${index}`) }]);
    const client = new FandomClient({ timeoutMs: 10, maxRetries: 0, fetch: (async () => { calls++; throw new Error("offline"); }) as unknown as typeof globalThis.fetch });
    const primary = new FandomCharacterSource(registry, client, new CharacterCache(db, 100), () => 0, undefined, { operationBudgetMs: 100, maxSeedAttempts: 4, maxConsecutiveFailures: 2 });
    const local = new LocalCharacterSource(Array.from({ length: 3 }, (_, index) => ({ id: `local-${index}`, name: `Local ${index}`, series: "Series" })));
    expect(await new LayeredCharacterSource(primary, local).getRandomCharacters(3)).toHaveLength(3);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("refreshes expired non-seed random rows once and serves stale data on error", async () => {
    const db = createDatabase(":memory:"); opened.push(db);
    new CharacterCache(db, 1, () => 1000).put("test", 9, { id: "fandom:test:9", name: "Cached", series: "Series", source: "fandom", sourceKey: "test" });
    let calls = 0;
    const client = new FandomClient({ timeoutMs: 10, maxRetries: 0, fetch: (async () => { calls++; throw new Error("offline"); }) as unknown as typeof globalThis.fetch });
    const source = new FandomCharacterSource(new AnimeWikiRegistry([{ key: "test", series: "Series", baseUrl: "https://wiki.example", seedTitles: [] }]), client, new CharacterCache(db, 1, () => 3000));
    const [first, second] = await Promise.all([source.getRandomCharacters(1), source.getRandomCharacters(1)]);
    expect(first[0]?.name).toBe("Cached");
    expect(second[0]?.name).toBe("Cached");
    expect(calls).toBe(1);
  });

  it("rejects corrupt cache rows instead of assigning sanitized fragments", () => {
    const db = createDatabase(":memory:"); opened.push(db);
    db.prepare("INSERT INTO character_cache VALUES ('fandom', 'test', 3, ?, ?, ?, NULL, NULL)").run(JSON.stringify({ id: "wrong", name: "", series: "Series", source: "fandom", sourceKey: "other", imageUrl: "http://bad/x.png" }), "invalid", "also-invalid");
    const cache = new CharacterCache(db, 100);
    expect(cache.get("test", 3)).toBeNull();
    expect(cache.list()).toEqual([]);
  });

  it("fills a layered deficit when the fallback cannot satisfy the original count alone", async () => {
    const primary = { getCharacterById: async () => null, getRandomCharacters: async () => [{ id: "remote", name: "Remote", series: "Series" }] };
    const local = new LocalCharacterSource([{ id: "local-a", name: "Local A", series: "Series" }, { id: "local-b", name: "Local B", series: "Series" }]);
    expect(await new LayeredCharacterSource(primary, local).getRandomCharacters(3)).toHaveLength(3);
  });

  it("keeps the enriched primary record when canonical identities overlap", async () => {
    const enriched = { id: "fandom:wiki:7", name: "Hero", series: "Series", source: "fandom" as const, sourceKey: "wiki", description: "Primary knowledge", knowledge: { aliases: ["Alias"], abilities: ["Power"] } };
    const primary = { getCharacterById: async () => null, getRandomCharacters: async () => [enriched], getCharactersBySeries: async () => [enriched] };
    const local = new LocalCharacterSource([{ id: "local-hero", name: "Hero", series: "Series" }, { id: "local-second", name: "Second", series: "Series" }]);
    const layered = new LayeredCharacterSource(primary, local);
    for (const result of [await layered.getRandomCharacters(2), await layered.getCharactersBySeries("Series", 2)]) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(enriched);
    }
  });

  it("deduplicates verified aliases within a normalized series while retaining the enriched primary", async () => {
    const enriched = { id: "fandom:aot:7", name: "Eren Jaeger", series: " Attack on Titan ", source: "fandom" as const, description: "Enriched", knowledge: { aliases: ["Eren Yeager"] } };
    const primary = { getCharacterById: async () => null, getRandomCharacters: async () => [enriched], getCharactersBySeries: async () => [enriched] };
    const local = new LocalCharacterSource([{ id: "local-eren", name: "Eren Yeager", series: "ＡＴＴＡＣＫ ON TITAN" }, { id: "local-mikasa", name: "Mikasa Ackerman", series: "Attack on Titan" }]);
    const layered = new LayeredCharacterSource(primary, local);
    for (const result of [await layered.getRandomCharacters(2), await layered.getCharactersBySeries("Attack on Titan", 2)]) {
      expect(result.map((item) => item.name)).toEqual(["Eren Jaeger", "Mikasa Ackerman"]);
      expect(result[0]).toEqual(enriched);
    }
  });

  it("does not deduplicate aliases across series or fuzzy-similar names", async () => {
    const primary = { getCharacterById: async () => null, getRandomCharacters: async () => [{ id: "remote", name: "Eren Jaeger", series: "Attack on Titan", knowledge: { aliases: ["Eren Yeager"] } }] };
    const local = new LocalCharacterSource([{ id: "other-series", name: "Eren Yeager", series: "Junior High" }, { id: "similar", name: "Eren Jager", series: "Attack on Titan" }]);
    expect((await new LayeredCharacterSource(primary, local).getRandomCharacters(3)).map((item) => item.id).sort()).toEqual(["other-series", "remote", "similar"]);
  });

  it("requests enough series fallback candidates to overcome canonical overlap", async () => {
    const calls: number[] = [];
    const primary = { getCharacterById: async () => null, getRandomCharacters: async () => [], getCharactersBySeries: async () => [{ id: "remote", name: "Hero", series: "Series" }] };
    const fallback = { getCharacterById: async () => null, getRandomCharacters: async () => [], getCharactersBySeries: async (_series: string, count: number) => { calls.push(count); return [{ id: "duplicate", name: "Hero", series: "Series" }, { id: "second", name: "Second", series: "Series" }, { id: "third", name: "Third", series: "Series" }].slice(0, count); } };
    expect((await new LayeredCharacterSource(primary, fallback).getCharactersBySeries("Series", 3)).map((item) => item.name)).toEqual(["Hero", "Second", "Third"]);
    expect(calls).toEqual([3]);
  });

  it("enumerates bounded incoming redirects on the canonical page and keeps wiki origins", async () => {
    const urls: URL[] = [];
    const fixture = page(7, "Light Yagami");
    Object.assign(fixture.query.pages[0], { redirects: [{ title: "Kira" }] });
    const client = new FandomClient({ timeoutMs: 100, maxRetries: 0, fetch: (async (input) => { urls.push(new URL(String(input))); return json(fixture); }) as typeof globalThis.fetch });
    const result = await client.getPage("https://deathnote.fandom.com", 7);
    expect(result?.redirects).toEqual(["Kira"]);
    expect(urls[0].origin).toBe("https://deathnote.fandom.com");
    expect(urls[0].searchParams.get("prop")).toContain("redirects");
    expect(urls[0].searchParams.get("rdlimit")).toBe("20");
  });
});
