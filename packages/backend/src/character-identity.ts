import type { CharacterSummary } from "@tebakani/shared";

function normalizeIdentityPart(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function nameTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function editDistanceWithin(left: string, right: string, maximum: number): number | null {
  if (Math.abs(left.length - right.length) > maximum) return null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > maximum) return null;
    previous = current;
  }
  return previous[right.length] <= maximum ? previous[right.length] : null;
}

function tokenTypoLimit(length: number): number {
  if (length <= 3) return 0;
  return length <= 7 ? 1 : 2;
}

export function characterNameMatches(guess: string, expected: string): boolean {
  const guessTokens = nameTokens(guess);
  const expectedTokens = nameTokens(expected);
  if (guessTokens.length === 0 || guessTokens.length !== expectedTokens.length) return false;

  const sortedGuess = [...guessTokens].sort();
  const sortedExpected = [...expectedTokens].sort();
  if (sortedGuess.every((token, index) => token === sortedExpected[index])) return true;

  const totalLength = expectedTokens.reduce((sum, token) => sum + token.length, 0);
  const totalBudget = totalLength >= 12 ? 2 : 1;
  const used = new Set<number>();

  function matchToken(index: number, distanceTotal: number): boolean {
    if (index === guessTokens.length) return true;
    for (let candidateIndex = 0; candidateIndex < expectedTokens.length; candidateIndex++) {
      if (used.has(candidateIndex)) continue;
      const limit = Math.min(tokenTypoLimit(guessTokens[index].length), tokenTypoLimit(expectedTokens[candidateIndex].length));
      const distance = editDistanceWithin(guessTokens[index], expectedTokens[candidateIndex], limit);
      if (distance === null || distanceTotal + distance > totalBudget) continue;
      used.add(candidateIndex);
      if (matchToken(index + 1, distanceTotal + distance)) return true;
      used.delete(candidateIndex);
    }
    return false;
  }

  return matchToken(0, 0);
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
