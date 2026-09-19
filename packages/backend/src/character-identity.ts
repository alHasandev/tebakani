import type { CharacterSummary } from "@tebakani/shared";

function normalizeIdentityPart(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function characterIdentityKeys(character: CharacterSummary) {
  const series = normalizeIdentityPart(character.series);
  const names = [character.name, ...(character.knowledge?.aliases ?? [])]
    .map(normalizeIdentityPart)
    .filter(Boolean);
  return [...new Set(names.map((name) => `${series}\0${name}`))];
}

export function uniqueCharacters(characters: CharacterSummary[]) {
  const seen = new Set<string>();
  const unique: CharacterSummary[] = [];
  for (const character of characters) {
    const keys = characterIdentityKeys(character);
    if (keys.some((key) => seen.has(key))) continue;
    unique.push(character);
    for (const key of keys) seen.add(key);
  }
  return unique;
}
