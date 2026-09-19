import type { CharacterSource, CharacterSummary } from "@tebakani/shared";

export const LOCAL_CHARACTERS: CharacterSummary[] = [
  {
    id: "char-01",
    name: "Monkey D. Luffy",
    series: "One Piece",
    description: "Captain of the Straw Hat Pirates with rubber abilities."
  },
  {
    id: "char-02",
    name: "Roronoa Zoro",
    series: "One Piece",
    description: "Master of the three-sword style and first mate of Straw Hats."
  },
  {
    id: "char-03",
    name: "Naruto Uzumaki",
    series: "Naruto",
    description: "Nine-tails jinchuriki who strives to become Hokage."
  },
  {
    id: "char-04",
    name: "Sasuke Uchiha",
    series: "Naruto",
    description: "Last survivor of the Uchiha clan wielding the Sharingan."
  },
  {
    id: "char-05",
    name: "Goku",
    series: "Dragon Ball",
    description: "Saiyan warrior defending Earth and striving for greater strength."
  },
  {
    id: "char-06",
    name: "Vegeta",
    series: "Dragon Ball",
    description: "Proud Saiyan prince and rival to Goku."
  },
  {
    id: "char-07",
    name: "Edward Elric",
    series: "Fullmetal Alchemist",
    description: "Youngest State Alchemist seeking the Philosopher's Stone."
  },
  {
    id: "char-08",
    name: "Roy Mustang",
    series: "Fullmetal Alchemist",
    description: "Flame Alchemist aiming to become Fuhrer of Amestris."
  },
  {
    id: "char-09",
    name: "Spike Spiegel",
    series: "Cowboy Bebop",
    description: "Laid-back bounty hunter with a mysterious past."
  },
  {
    id: "char-10",
    name: "Levi Ackerman",
    series: "Attack on Titan",
    description: "Captain of the Special Operations Squad, humanity's strongest soldier."
  },
  {
    id: "char-11",
    name: "Eren Yeager",
    series: "Attack on Titan",
    description: "Survey Corps member driven to eliminate all Titans."
  },
  {
    id: "char-12",
    name: "Killua Zoldyck",
    series: "Hunter x Hunter",
    description: "Prodigy assassin turned Hunter wielding lightning Nen."
  },
  {
    id: "char-13",
    name: "Gon Freecss",
    series: "Hunter x Hunter",
    description: "Determined young boy searching for his father Ging."
  },
  {
    id: "char-14",
    name: "Saitama",
    series: "One Punch Man",
    description: "Hero for fun who defeats any opponent in a single punch."
  },
  {
    id: "char-15",
    name: "Genos",
    series: "One Punch Man",
    description: "Cyborg disciple of Saitama seeking revenge for his hometown."
  },
  {
    id: "char-16",
    name: "Tanjiro Kamado",
    series: "Demon Slayer",
    description: "Kind-hearted demon slayer searching for a cure for Nezuko."
  },
  {
    id: "char-17",
    name: "Nezuko Kamado",
    series: "Demon Slayer",
    description: "Demon sister who protects humans alongside Tanjiro."
  },
  {
    id: "char-18",
    name: "Satoru Gojo",
    series: "Jujutsu Kaisen",
    description: "Special grade jujutsu sorcerer with Six Eyes and Limitless cursed technique."
  },
  {
    id: "char-19",
    name: "Megumi Fushiguro",
    series: "Jujutsu Kaisen",
    description: "Jujutsu sorcerer utilizing the Ten Shadows technique."
  },
  {
    id: "char-20",
    name: "Light Yagami",
    series: "Death Note",
    description: "Genius high schooler who aims to create a new world as Kira."
  },
  {
    id: "char-21",
    name: "L Lawliet",
    series: "Death Note",
    description: "Eccentric world-renowned detective pursuing Kira."
  },
  {
    id: "char-22",
    name: "Shinji Ikari",
    series: "Neon Genesis Evangelion",
    description: "Pilot of Evangelion Unit-01 struggling with existential doubt."
  },
  {
    id: "char-23",
    name: "Asuka Langley Soryu",
    series: "Neon Genesis Evangelion",
    description: "Proud and fierce pilot of Evangelion Unit-02."
  },
  {
    id: "char-24",
    name: "Gintoki Sakata",
    series: "Gintama",
    description: "Former samurai operating the Yorozuya odd-jobs agency."
  }
];

export class LocalCharacterSource implements CharacterSource {
  private characters: CharacterSummary[];

  constructor(customCharacters: CharacterSummary[] = LOCAL_CHARACTERS) {
    this.characters = customCharacters;
  }

  async getCharacterById(id: string): Promise<CharacterSummary | null> {
    const found = this.characters.find((c) => c.id === id);
    return found ? { ...found } : null;
  }

  async getCharactersBySeries(series: string, count: number): Promise<CharacterSummary[]> {
    const matching = this.characters.filter((character) => character.series.localeCompare(series, undefined, { sensitivity: "base" }) === 0);
    return this.randomize(matching).slice(0, count).map((character) => ({ ...character }));
  }

  async searchCharacters(query: string, options: { series?: string; limit?: number } = {}): Promise<CharacterSummary[]> {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    const limit = Math.min(20, Math.max(1, options.limit ?? 10));
    const matches = this.characters.filter((character) => (!options.series || character.series.localeCompare(options.series, undefined, { sensitivity: "base" }) === 0) && character.name.normalize("NFKC").toLocaleLowerCase().includes(normalized));
    return matches.sort((left, right) => Number(right.name.normalize("NFKC").toLocaleLowerCase() === normalized) - Number(left.name.normalize("NFKC").toLocaleLowerCase() === normalized)).slice(0, limit).map((character) => ({ ...character }));
  }

  async getRandomCharacters(count: number): Promise<CharacterSummary[]> {
    if (count > this.characters.length) {
      throw new Error(`Requested ${count} characters, but only ${this.characters.length} are available`);
    }

    return this.randomize(this.characters).slice(0, count).map((character) => ({ ...character }));
  }

  private randomize(characters: CharacterSummary[]): CharacterSummary[] {
    const pool = [...characters];
    for (let index = pool.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[randomIndex]] = [pool[randomIndex], pool[index]];
    }
    return pool;
  }
}
