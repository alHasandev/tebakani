import { Database } from "bun:sqlite";
import type { CharacterSummary } from "@tebakani/shared";
import { sanitizeCharacter } from "./character-sanitize";

export interface CacheEntry { character: CharacterSummary; expired: boolean; pageId: number; sourceKey: string; etag?: string; lastModified?: string }
export class CharacterCache {
  constructor(private readonly db: Database, private readonly ttlSeconds: number, private readonly now: () => number = Date.now) {}
  get(sourceKey: string, pageId: number): CacheEntry | null {
    const row = this.db.prepare("SELECT source, source_key, page_id, normalized_json, fetched_at, expires_at, etag, last_modified FROM character_cache WHERE source = 'fandom' AND source_key = ? AND page_id = ?").get(sourceKey, pageId) as any;
    return row ? this.parseRow(row) : null;
  }
  put(sourceKey: string, pageId: number, character: CharacterSummary, metadata: { etag?: string; lastModified?: string } = {}) {
    const now = new Date(this.now()); const expires = new Date(now.getTime() + this.ttlSeconds * 1000);
    const normalized = sanitizeCharacter({ ...character, id: `fandom:${sourceKey}:${pageId}`, source: "fandom", sourceKey });
    if (!normalized.name || !normalized.series) throw new Error("Invalid character cache entry");
    this.db.prepare(`INSERT INTO character_cache (source, source_key, page_id, normalized_json, fetched_at, expires_at, etag, last_modified)
      VALUES ('fandom', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, source_key, page_id) DO UPDATE SET normalized_json=excluded.normalized_json, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at, etag=excluded.etag, last_modified=excluded.last_modified`).run(sourceKey, pageId, JSON.stringify(normalized), now.toISOString(), expires.toISOString(), metadata.etag ?? null, metadata.lastModified ?? null);
  }
  list(sourceKey?: string): CacheEntry[] {
    const columns = "source, source_key, page_id, normalized_json, fetched_at, expires_at, etag, last_modified";
    const rows = sourceKey ? this.db.prepare(`SELECT ${columns} FROM character_cache WHERE source='fandom' AND source_key=? ORDER BY page_id`).all(sourceKey) : this.db.prepare(`SELECT ${columns} FROM character_cache WHERE source='fandom' ORDER BY source_key, page_id`).all();
    return (rows as any[]).flatMap((row) => { const entry = this.parseRow(row); return entry ? [entry] : []; });
  }
  private parseRow(row: any): CacheEntry | null {
    try {
      if (row.source !== "fandom" || typeof row.source_key !== "string" || !row.source_key.trim() || !Number.isInteger(row.page_id) || row.page_id <= 0) return null;
      const fetchedAt = Date.parse(row.fetched_at); const expiresAt = Date.parse(row.expires_at);
      if (!Number.isFinite(fetchedAt) || !Number.isFinite(expiresAt) || expiresAt < fetchedAt) return null;
      const raw = JSON.parse(row.normalized_json);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const character = sanitizeCharacter(raw);
      if (!character.id || !character.name || !character.series || character.source !== "fandom" || character.sourceKey !== row.source_key || character.id !== `fandom:${row.source_key}:${row.page_id}`) return null;
      if (raw.imageUrl !== undefined && character.imageUrl === undefined) return null;
      return { character, expired: expiresAt <= this.now(), pageId: row.page_id, sourceKey: row.source_key, etag: row.etag ?? undefined, lastModified: row.last_modified ?? undefined };
    } catch { return null; }
  }
}
