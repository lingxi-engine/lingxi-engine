/**
 * 网络搜索 Provider 抽象层
 * 
 * 架构：多 Provider 自动降级，零配置可用
 * 
 * 优先级（自动选择）：
 *   1. Tavily（有 API Key 时启用，AI 专用搜索，质量最高）
 *   2. Brave Search（有 API Key 时启用，结构化结果）
 *   3. SearXNG 公共实例（免 Key，轮换多个节点）
 *   4. DuckDuckGo HTML（免 Key，无限用，兜底）
 * 
 * 用户不需要注册任何东西就能用。配了 Key 自动升级。
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  name: string;
  available: boolean;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

// ──────────── Provider 1: Tavily（AI 专用搜索）───────────

class TavilyProvider implements SearchProvider {
  name = 'tavily';
  available = false;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.TAVILY_API_KEY || '';
    this.available = !!this.apiKey;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.available) return [];
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: maxResults,
          search_depth: 'advanced',
          include_answer: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      const results: SearchResult[] = [];
      if (data.answer) {
        results.push({ title: 'AI 摘要', url: '', snippet: data.answer });
      }
      if (data.results) {
        for (const r of data.results.slice(0, maxResults)) {
          results.push({ title: r.title || '', url: r.url || '', snippet: r.content || '' });
        }
      }
      return results;
    } catch (e: any) {
      console.warn('[Search] Provider 搜索失败:', e?.message || e);
      return [];
    }
  }
}

// ──────────── Provider 2: Brave Search（结构化结果）───────────

class BraveProvider implements SearchProvider {
  name = 'brave';
  available = false;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.BRAVE_API_KEY || '';
    this.available = !!this.apiKey;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.available) return [];
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
        headers: {
          'X-Subscription-Token': this.apiKey,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      const results: SearchResult[] = [];
      if (data.web?.results) {
        for (const r of data.web.results.slice(0, maxResults)) {
          results.push({
            title: r.title || '',
            url: r.url || '',
            snippet: r.description || r.meta_url?.snippet || '',
          });
        }
      }
      return results;
    } catch (e: any) {
      console.warn('[Search] Provider 搜索失败:', e?.message || e);
      return [];
    }
  }
}

// ──────────── Provider 3: SearXNG 公共实例（免 Key）───────────

const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.inetol.net',
  'https://searx.tuxcloud.net',
  'https://opnxng.de',
];

class SearXNGProvider implements SearchProvider {
  name = 'searxng';
  available = true; // 免 Key，始终可用

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    // 轮换实例，每个试一遍
    for (const base of SEARXNG_INSTANCES) {
      try {
        const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&pageno=1`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const data = await res.json() as any;
        if (data.results && data.results.length > 0) {
          return data.results.slice(0, maxResults).map((r: any) => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
          }));
        }
      } catch {
        continue; // 换下一个实例
      }
    }
    return [];
  }
}

// ──────────── Provider 4: Bing CN（免 Key，国内可用兜底）───────────

class BingCNProvider implements SearchProvider {
  name = 'bing-cn';
  available = true;

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      const html = await res.text();
      const results: SearchResult[] = [];
      // Bing 结果格式: <h2><a href="url">title</a></h2><p>snippet</p>
      const blockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
      let m;
      while ((m = blockRegex.exec(html)) !== null && results.length < maxResults) {
        const block = m[1];
        const urlMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (urlMatch) {
          results.push({
            title: urlMatch[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
            url: urlMatch[1],
            snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '',
          });
        }
      }
      return results;
    } catch (e: any) {
      console.warn('[Search] Bing CN 搜索失败:', e?.message || e);
      return [];
    }
  }
}

class DDGLiteProvider implements SearchProvider {
  name = 'ddg-lite';
  available = true;

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LingXi/1.0)' },
      });
      const html = await res.text();
      const results: SearchResult[] = [];
      // Lite 版格式: <a href="url">title</a><br><span class="snippet">snippet</span>
      const rowRegex = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<span[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/span>/gi;
      let m;
      while ((m = rowRegex.exec(html)) !== null && results.length < maxResults) {
        results.push({
          title: m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
          url: m[1],
          snippet: m[3].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
        });
      }
      // Fallback: 简单链接提取
      if (results.length === 0) {
        const linkRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([^<]*)<\/a>/gi;
        while ((m = linkRegex.exec(html)) !== null && results.length < maxResults) {
          const title = m[2].replace(/&amp;/g, '&').trim();
          if (title.length > 5 && !title.includes('DuckDuckGo')) {
            results.push({ title, url: m[1], snippet: '' });
          }
        }
      }
      return results;
    } catch (e: any) {
      console.warn('[Search] DDG Lite 搜索失败:', e?.message || e);
      return [];
    }
  }
}

// ──────────── Provider 5: DuckDuckGo HTML（免 Key 兜底）───────────

class DuckDuckGoProvider implements SearchProvider {
  name = 'duckduckgo';
  available = true; // 免 Key，始终可用

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(htmlUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const html = await res.text();
      const results: SearchResult[] = [];

      // 解析 DuckDuckGo HTML 结果
      const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const links: string[] = [];
      const titles: string[] = [];
      const snippets: string[] = [];
      let m;
      while ((m = linkRegex.exec(html)) !== null && links.length < maxResults) {
        // DuckDuckGo 的 URL 是跳转链接，提取真实 URL
        let rawUrl = m[1];
        const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);
        links.push(rawUrl);
        titles.push(m[2].replace(/<[^>]*>/g, '').trim());
      }
      let s;
      while ((s = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
        snippets.push(s[1].replace(/<[^>]*>/g, '').trim());
      }
      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        results.push({ title: titles[i] || query, url: links[i] || '', snippet: snippets[i] || '' });
      }

      // 如果 HTML 没结果，试 JSON API
      if (results.length === 0) {
        const suggestUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const res2 = await fetch(suggestUrl, { signal: AbortSignal.timeout(6000) });
        const data = await res2.json() as any;
        if (data.Abstract) {
          results.push({ title: data.Heading || query, url: data.AbstractURL || '', snippet: data.Abstract });
        }
        // 相关主题
        if (data.RelatedTopics) {
          for (const t of data.RelatedTopics.slice(0, maxResults - results.length)) {
            if (t.Text && t.FirstURL) {
              results.push({ title: t.Text.slice(0, 60), url: t.FirstURL, snippet: t.Text });
            }
          }
        }
      }

      return results;
    } catch (e: any) {
      console.warn('[Search] Provider 搜索失败:', e?.message || e);
      return [];
    }
  }
}

// ──────────── 搜索管理器 ────────────

export class SearchManager {
  private providers: SearchProvider[] = [];
  private cache: Map<string, { results: SearchResult[]; time: number }> = new Map();
  private cacheMs: number = 15 * 60 * 1000; // 15 分钟缓存
  private maxCacheSize: number = 200;

  constructor() {
    // 按优先级注册：有 Key 的在前，免 Key 的在后
    this.providers = [
      new TavilyProvider(),
      new BraveProvider(),
      new BingCNProvider(),
      new SearXNGProvider(),
      new DDGLiteProvider(),
      new DuckDuckGoProvider(),
    ];
    const activeProviders = this.providers.filter(p => p.available).map(p => p.name);
    console.log(`[Search] 搜索 Provider 就绪: ${activeProviders.join(' → ')}`);
  }

  async search(query: string, maxResults: number = 5): Promise<{ query: string; results: SearchResult[]; source: string }> {
    // 检查缓存
    const cacheKey = `${query}::${maxResults}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheMs) {
      return { query, results: cached.results, source: 'cache' };
    }

    // 按优先级尝试每个 provider，第一个有结果就用
    const errors: string[] = [];
    for (const provider of this.providers) {
      if (!provider.available) continue;
      try {
        const results = await provider.search(query, maxResults);
        if (results.length > 0) {
          // 缓存结果
          // 定期清理过期缓存，防止内存泄漏
          if (this.cache.size > this.maxCacheSize) {
            const keys = [...this.cache.keys()];
            for (const k of keys.slice(0, keys.length - 100)) this.cache.delete(k);
          }
          this.cache.set(cacheKey, { results, time: Date.now() });
          return { query, results, source: provider.name };
        }
      } catch (e: any) {
        errors.push(`${provider.name}: ${e?.message || 'unknown'}`);
        continue; // 换下一个 provider
      }
    }
    if (errors.length > 0) {
      console.warn(`[Search] 所有 Provider 失败: ${errors.join('; ')}`);
    }

    // 全部失败，返回 Google 链接兜底
    const fallback: SearchResult[] = [{
      title: "搜索建议",
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      snippet: `所有搜索源均未返回结果，请尝试用浏览器手动搜索。`,
    }];
    return { query, results: fallback, source: 'fallback' };
  }

  /** 获取当前可用的 provider 列表（给 UI 用） */
  listProviders(): { name: string; available: boolean }[] {
    return this.providers.map(p => ({ name: p.name, available: p.available }));
  }
}