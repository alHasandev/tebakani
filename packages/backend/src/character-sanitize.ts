import type { CharacterKnowledge, CharacterSummary } from "@tebakani/shared";

const MAX_FIELD = 500;
const MAX_DESCRIPTION = 1600;
const MAX_ARRAY = 16;

export function sanitizeExternalText(value: unknown, maxLength = MAX_FIELD): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\[(?:https?:\/\/\S+)\s*([^\]]*)\]/g, "$1")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/'{2,}/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const clean = sanitizeExternalText(item, 120);
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key)) return [];
    seen.add(key);
    return [clean];
  }).slice(0, MAX_ARRAY);
}

const NON_CHARACTER = /\b(?:episode|chapter|volume|location|technique|ability|organization|faction|list of|disambiguation|category|template|file|forum|blog|user)\b/i;
export function isLikelyCharacterPage(title: string, categories: string[] = [], namespace = 0): boolean {
  if (namespace !== 0 || title.includes(":")) return false;
  const categoryText = categories.join(" ");
  if (/disambiguation/i.test(categoryText) || NON_CHARACTER.test(title)) return false;
  if (/\b(?:episodes?|chapters?|locations?|techniques?|organizations?)\b/i.test(categoryText)) return false;
  return !categories.length || /characters?|people|humans?|protagonists?|antagonists?/i.test(categoryText);
}

export function sanitizeCharacter(input: CharacterSummary): CharacterSummary {
  const knowledge: CharacterKnowledge | undefined = input.knowledge ? {
    aliases: sanitizeStringArray(input.knowledge.aliases),
    gender: sanitizeExternalText(input.knowledge.gender, 60) || undefined,
    species: sanitizeExternalText(input.knowledge.species, 100) || undefined,
    affiliations: sanitizeStringArray(input.knowledge.affiliations),
    abilities: sanitizeStringArray(input.knowledge.abilities),
    occupation: sanitizeStringArray(input.knowledge.occupation),
    status: sanitizeExternalText(input.knowledge.status, 80) || undefined,
    notableTraits: sanitizeStringArray(input.knowledge.notableTraits)
  } : undefined;
  return {
    id: sanitizeExternalText(input.id, 180),
    name: sanitizeExternalText(input.name, 120),
    series: sanitizeExternalText(input.series, 120),
    imageUrl: validateHttpsImageUrl(input.imageUrl),
    description: sanitizeExternalText(input.description, MAX_DESCRIPTION) || undefined,
    source: input.source === "fandom" ? "fandom" : input.source === "local" ? "local" : undefined,
    sourceKey: sanitizeExternalText(input.sourceKey, 80) || undefined,
    sourceUrl: validateHttpsUrl(input.sourceUrl),
    knowledge
  };
}

export function validateHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : undefined; } catch { return undefined; }
}

export function validateHttpsImageUrl(value: unknown): string | undefined {
  const url = validateHttpsUrl(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const fandomCdn = /(^|\.)nocookie\.net$/i.test(parsed.hostname) && /\/revision\/latest(?:\/|$)/i.test(parsed.pathname);
    return fandomCdn || /\.(?:png|jpe?g|webp|gif)$/i.test(parsed.pathname) ? parsed.toString() : undefined;
  } catch { return undefined; }
}
