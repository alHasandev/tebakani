import { describe, expect, it } from "bun:test";
import { characterNameMatches } from "../src/character-identity";
import { LOCAL_CHARACTERS } from "../src/character-source";

describe("characterNameMatches", () => {
  it.each([
    ["Light Yagami", "Light Yagami"],
    ["Yagami Light", "Light Yagami"],
    ["Laight Yagami", "Light Yagami"],
    ["Uzumaki Naruto", "Naruto Uzumaki"],
    ["Naruto Uzunaki", "Naruto Uzumaki"],
    ["Kamado Tanjiro", "Tanjiro Kamado"],
    ["Tanjiiro Kamado", "Tanjiro Kamado"],
    ["Monkey D Luffy", "Monkey D. Luffy"]
  ])("accepts %s for %s", (guess, expected) => {
    expect(characterNameMatches(guess, expected)).toBe(true);
  });

  it("recognizes common Goku names through verified aliases", () => {
    const goku = LOCAL_CHARACTERS.find((character) => character.id === "char-05")!;
    const verifiedNames = [goku.name, ...(goku.knowledge?.aliases ?? [])];
    for (const guess of ["Goku", "Son Goku", "Sun Goku", "Kakarot", "Kakarotto", "Son Gokuu"]) {
      expect(verifiedNames.some((name) => characterNameMatches(guess, name))).toBe(true);
    }
  });

  it.each([
    ["Light Turner", "Light Yagami"],
    ["Naruto Uchiha", "Naruto Uzumaki"],
    ["Tanjiro Hashibira", "Tanjiro Kamado"],
    ["Ace", "Axe"],
    ["L", "I"],
    ["Naruto", "Naruto Uzumaki"]
  ])("rejects %s for %s", (guess, expected) => {
    expect(characterNameMatches(guess, expected)).toBe(false);
  });
});
