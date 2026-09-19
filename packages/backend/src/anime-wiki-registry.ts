export interface WikiConfig {
  key: string;
  series: string;
  baseUrl: string;
  seedTitles: string[];
}

const CURATED: WikiConfig[] = [
  { key: "onepiece", series: "One Piece", baseUrl: "https://onepiece.fandom.com", seedTitles: ["Monkey D. Luffy", "Roronoa Zoro", "Nami", "Sanji"] },
  { key: "naruto", series: "Naruto", baseUrl: "https://naruto.fandom.com", seedTitles: ["Naruto Uzumaki", "Sasuke Uchiha", "Sakura Haruno", "Kakashi Hatake"] },
  { key: "dragonball", series: "Dragon Ball", baseUrl: "https://dragonball.fandom.com", seedTitles: ["Goku", "Vegeta", "Piccolo", "Gohan"] },
  { key: "fullmetal-alchemist", series: "Fullmetal Alchemist", baseUrl: "https://fma.fandom.com", seedTitles: ["Edward Elric", "Alphonse Elric", "Roy Mustang", "Winry Rockbell"] },
  { key: "attack-on-titan", series: "Attack on Titan", baseUrl: "https://attackontitan.fandom.com", seedTitles: ["Eren Jaeger", "Mikasa Ackerman", "Armin Arlert", "Levi Ackerman"] },
  { key: "hunterxhunter", series: "Hunter x Hunter", baseUrl: "https://hunterxhunter.fandom.com", seedTitles: ["Gon Freecss", "Killua Zoldyck", "Kurapika", "Leorio Paradinight"] },
  { key: "onepunchman", series: "One Punch Man", baseUrl: "https://onepunchman.fandom.com", seedTitles: ["Saitama", "Genos", "Tatsumaki", "Garou"] },
  { key: "kimetsu-no-yaiba", series: "Demon Slayer", baseUrl: "https://kimetsu-no-yaiba.fandom.com", seedTitles: ["Tanjiro Kamado", "Nezuko Kamado", "Zenitsu Agatsuma", "Inosuke Hashibira"] },
  { key: "jujutsu-kaisen", series: "Jujutsu Kaisen", baseUrl: "https://jujutsu-kaisen.fandom.com", seedTitles: ["Yuji Itadori", "Megumi Fushiguro", "Nobara Kugisaki", "Satoru Gojo"] },
  { key: "deathnote", series: "Death Note", baseUrl: "https://deathnote.fandom.com", seedTitles: ["Light Yagami", "L (character)", "Misa Amane", "Ryuk"] }
];

function normalizeSeries(value: string) { return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function validBaseUrl(value: string): string { const url = new URL(value); if (url.protocol !== "https:") throw new Error("FANDOM_BASE_URL must be a valid HTTPS URL"); return url.toString().replace(/\/$/, ""); }

export class AnimeWikiRegistry {
  private readonly bySeries = new Map<string, WikiConfig>();
  private readonly byKey = new Map<string, WikiConfig>();
  constructor(configs: WikiConfig[] = CURATED, customBaseUrl?: string) {
    for (const entry of configs) this.register(entry);
    if (customBaseUrl) this.register({ key: "custom", series: "Custom", baseUrl: customBaseUrl, seedTitles: [] });
  }
  register(config: WikiConfig) { const clean = { ...config, baseUrl: validBaseUrl(config.baseUrl), seedTitles: [...config.seedTitles] }; this.bySeries.set(normalizeSeries(clean.series), clean); this.byKey.set(clean.key, clean); }
  lookupSeries(series: string) { return this.bySeries.get(normalizeSeries(series)); }
  lookupKey(key: string) { return this.byKey.get(key); }
  list() { return [...this.byKey.values()]; }
}
