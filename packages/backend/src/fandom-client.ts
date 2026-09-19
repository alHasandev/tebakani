export interface FandomClientOptions { timeoutMs: number; maxRetries: number; concurrency?: number; fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void> }
export interface WikiSearchResult { pageId: number; title: string; namespace: number }
export interface WikiPage { pageId: number; title: string; namespace: number; extract: string; wikitext: string; redirects: string[]; imageUrl?: string; pageUrl?: string; categories: string[]; etag?: string; lastModified?: string }

export class FandomClientError extends Error { constructor(message: string) { super(message); this.name = "FandomClientError"; } }

export class FandomClient {
  private active = 0;
  private waiting: Array<() => void> = [];
  private inflight = new Map<string, Promise<any>>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  constructor(private readonly options: FandomClientOptions) { this.fetcher = options.fetch ?? globalThis.fetch; this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms)); this.maxRetries = Math.min(5, Math.max(0, options.maxRetries)); }

  async search(baseUrl: string, query: string, limit = 10): Promise<WikiSearchResult[]> {
    const boundedLimit = Math.min(20, Math.max(1, limit));
    const run = async (srsearch: string) => this.parseSearch((await this.request(baseUrl, { action: "query", list: "search", srsearch, srnamespace: "0", srlimit: String(boundedLimit), srprop: "", format: "json", formatversion: "2", origin: "*" })).data);
    const exact = await run(`intitle:\"${query}\"`);
    const exactMatches = exact.filter((item) => item.title.normalize("NFKC").trim().toLocaleLowerCase() === query.normalize("NFKC").trim().toLocaleLowerCase());
    return (exactMatches.length ? exactMatches : await run(query)).slice(0, boundedLimit);
  }

  async getPage(baseUrl: string, pageId: number): Promise<WikiPage | null> {
    const params = { action: "query", pageids: String(pageId), prop: "extracts|pageimages|info|categories|revisions|redirects", exintro: "1", explaintext: "1", piprop: "original", inprop: "url", cllimit: "max", rvprop: "content", rvslots: "main", rdlimit: "20", format: "json", formatversion: "2", origin: "*" };
    const response = await this.request(baseUrl, params);
    const pages = response.data?.query?.pages;
    if (!Array.isArray(pages)) throw new FandomClientError("Fandom provider returned an invalid response shape");
    const page = pages[0];
    if (!page || page.missing) return null;
    if (!Number.isInteger(page.pageid) || typeof page.title !== "string") throw new FandomClientError("Fandom provider returned an invalid response shape");
    const redirects: string[] = [];
    let current: any = response;
    for (let requestCount = 0; requestCount < 3; requestCount++) {
      const currentPage = current.data?.query?.pages?.find((item: any) => item?.pageid === page.pageid);
      if (Array.isArray(currentPage?.redirects)) {
        for (const redirect of currentPage.redirects) if (typeof redirect?.title === "string" && redirects.length < 50) redirects.push(redirect.title);
      }
      const continuation = current.data?.continue?.rdcontinue;
      if (typeof continuation !== "string" || redirects.length >= 50 || requestCount === 2) break;
      current = await this.request(baseUrl, { ...params, rdcontinue: continuation, continue: "-||" });
    }
    const content = page.revisions?.[0]?.slots?.main?.content ?? page.revisions?.[0]?.content ?? "";
    return { pageId: page.pageid, title: page.title, namespace: page.ns ?? 0, extract: typeof page.extract === "string" ? page.extract : "", wikitext: typeof content === "string" ? content : "", redirects, imageUrl: page.original?.source, pageUrl: page.fullurl, categories: Array.isArray(page.categories) ? page.categories.map((item: any) => String(item.title ?? "").replace(/^Category:/i, "")) : [], etag: response.etag, lastModified: response.lastModified };
  }

  private parseSearch(data: any): WikiSearchResult[] {
    const search = data?.query?.search;
    if (!Array.isArray(search)) throw new FandomClientError("Fandom provider returned an invalid response shape");
    return search.flatMap((item: any) => Number.isInteger(item.pageid) && typeof item.title === "string" ? [{ pageId: item.pageid, title: item.title, namespace: Number.isInteger(item.ns) ? item.ns : 0 }] : []);
  }
  private request(baseUrl: string, params: Record<string, string>): Promise<{ data: any; etag?: string; lastModified?: string }> {
    const api = new URL("api.php", `${baseUrl.replace(/\/$/, "")}/`); Object.entries(params).forEach(([key, value]) => api.searchParams.set(key, value));
    const key = api.toString(); const existing = this.inflight.get(key); if (existing) return existing;
    const promise = this.withSlot(() => this.fetchWithRetry(api)).finally(() => this.inflight.delete(key)); this.inflight.set(key, promise); return promise;
  }
  private async withSlot<T>(run: () => Promise<T>): Promise<T> { const limit = Math.min(16, Math.max(1, this.options.concurrency ?? 4)); if (this.active >= limit) await new Promise<void>((resolve) => this.waiting.push(resolve)); this.active++; try { return await run(); } finally { this.active--; this.waiting.shift()?.(); } }
  private async fetchWithRetry(url: URL) {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await this.fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.options.timeoutMs) }); }
      catch { if (attempt >= this.maxRetries) throw new FandomClientError("Fandom provider network request failed"); await this.sleep(100 * 2 ** attempt); continue; }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) { const header = response.headers.get("retry-after"); const retryAfter = header === null ? Number.NaN : Number(header); await this.sleep(Number.isFinite(retryAfter) ? Math.min(2000, Math.max(0, retryAfter * 1000)) : 100 * 2 ** attempt); continue; }
        throw new FandomClientError(`Fandom provider returned HTTP ${response.status}`);
      }
      let data: any;
      try { data = await response.json(); } catch { throw new FandomClientError("Fandom provider returned malformed JSON"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new FandomClientError("Fandom provider returned an invalid response shape");
      if (data.error) throw new FandomClientError("Fandom provider rejected the request");
      return { data, etag: response.headers.get("etag") ?? undefined, lastModified: response.headers.get("last-modified") ?? undefined };
    }
  }
}
