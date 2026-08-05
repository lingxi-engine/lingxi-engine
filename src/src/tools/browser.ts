/**
 * 浏览器自动化工具 - Browser Automation
 * 基于 Puppeteer (Chromium headless)
 * 
 * 能力：
 *   - 打开网页 / 导航
 *   - 截图 / 获取 HTML
 *   - 点击 / 输入 / 表单填写
 *   - 等待元素 / 提取文本
 *   - 执行自定义 JS
 */

import type { ToolDefinition } from "../tools/types.js";

// ── 工具定义 ──

const TOOL_BROWSER_OPEN: ToolDefinition = {
  name: "browser_open",
  description: "Open a URL in a headless browser. Returns the page title and a snapshot of visible text. Use for web scraping, testing, or research.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to open, e.g. https://example.com",
      },
      waitMs: {
        type: "number",
        description: "Time to wait for page load in ms, default 3000",
        default: 3000,
      },
    },
    required: ["url"],
  },
};

const TOOL_BROWSER_CLICK: ToolDefinition = {
  name: "browser_click",
  description: "Click an element on the current browser page by CSS selector. Use after browser_open.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector of the element to click, e.g. 'button.submit' or '#login-btn'",
      },
    },
    required: ["selector"],
  },
};

const TOOL_BROWSER_TYPE: ToolDefinition = {
  name: "browser_type",
  description: "Type text into an input field on the current browser page. Use after browser_open.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector of the input field, e.g. 'input[name=\"q\"]' or '#search-box'",
      },
      text: {
        type: "string",
        description: "Text to type into the field",
      },
      submit: {
        type: "boolean",
        description: "Press Enter after typing (useful for search forms), default false",
        default: false,
      },
    },
    required: ["selector", "text"],
  },
};

const TOOL_BROWSER_SCREENSHOT: ToolDefinition = {
  name: "browser_screenshot",
  description: "Take a screenshot of the current browser page. Returns the file path of the saved image.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "Optional CSS selector to screenshot a specific element. If omitted, full page screenshot.",
      },
    },
    required: [],
  },
};

const TOOL_BROWSER_EXTRACT: ToolDefinition = {
  name: "browser_extract",
  description: "Extract text content from the current browser page by CSS selector. Returns the text content of matching elements.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to extract text from, e.g. 'article' or '.content p'",
      },
      attribute: {
        type: "string",
        description: "Optional attribute to extract instead of text, e.g. 'href' or 'src'",
      },
    },
    required: ["selector"],
  },
};

const TOOL_BROWSER_EXEC: ToolDefinition = {
  name: "browser_exec",
  description: "Execute JavaScript code in the current browser page context. Use for custom extraction or interaction. Returns the result value.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to execute in the page context. Use `return` to return a value.",
      },
    },
    required: ["code"],
  },
};

// ── 浏览器管理器 ──

export class BrowserManager {
  private browser: any = null;
  private page: any = null;
  private puppeteer: any = null;
  private currentUrl: string = '';
  private screenshotsDir: string = '';
  private screenshotCount = 0;
  private _initPromise: Promise<boolean> | null = null;

  async init(screenshotsDir?: string): Promise<boolean> {
    this.screenshotsDir = screenshotsDir || '';
    // 懒加载：启动时只检查 puppeteer 是否安装，不启动浏览器
    try {
      this.puppeteer = await import('puppeteer');
      console.log('[Browser] Puppeteer 已安装（按需启动）');
      return true;
    } catch (err: any) {
      console.log('[Browser] Puppeteer 不可用:', err.message);
      console.log('[Browser] 请运行: npm install puppeteer');
      this.puppeteer = null;
      return false;
    }
  }

  /** 按需启动浏览器（带并发保护） */
  private async ensureBrowser(): Promise<boolean> {
    if (this.browser && this.page) return true;
    if (!this.puppeteer) return false;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._launchBrowser();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  private async _launchBrowser(): Promise<boolean> {
    try {
      this.browser = await this.puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-software-rasterizer', '--disable-features=TranslateUI',
          '--no-first-run', '--no-default-browser-check',
          '--disable-extensions', '--disable-sync',
          '--window-size=1280,800', '--window-position=-32000,-32000',
        ],
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });
      console.log('[Browser] Puppeteer 浏览器已按需启动');
      return true;
    } catch (err: any) {
      console.error('[Browser] 启动失败:', err.message);
      return false;
    }
  }

  isAvailable(): boolean {
    return !!this.browser && !!this.page;
  }

  // ── 工具实现 ──

  async handleOpen(args: Record<string, any>): Promise<any> {
    if (!this.isAvailable()) return { error: '浏览器未初始化，请先安装 puppeteer: npm install puppeteer' };
    if (!await this.ensureBrowser()) return { error: '浏览器启动失败' };
    const { url, waitMs = 3000 } = args;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return { error: '仅支持 http/https 协议' };
      const h = parsed.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h.startsWith('192.168.') || h.startsWith('10.') || h.startsWith('172.16.') || h === '169.254.169.254' || h === '[::1]') return { error: '不允许访问内网地址' };
    } catch { return { error: '无效 URL' }; }
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, waitMs));
      this.currentUrl = url;
      const title = await this.page.title();
      const text = await this.page.evaluate(() => {
        return document.body?.innerText?.slice(0, 3000) || '';
      });
      return { url, title, text: text.slice(0, 2000), ok: true };
    } catch (err: any) {
      return { error: `打开失败: ${err.message}`, url };
    }
  }

  async handleClick(args: Record<string, any>): Promise<any> {
    if (!this.isAvailable()) return { error: '浏览器未初始化' };
    const { selector } = args;
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.click(selector);
      await new Promise(r => setTimeout(r, 1000));
      return { selector, clicked: true, ok: true };
    } catch (err: any) {
      return { error: `点击失败: ${err.message}`, selector };
    }
  }

  async handleType(args: Record<string, any>): Promise<any> {
    if (!this.isAvailable()) return { error: '浏览器未初始化' };
    const { selector, text, submit = false } = args;
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.type(selector, text);
      if (submit) {
        await this.page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000));
      }
      return { selector, typed: text, submitted: submit, ok: true };
    } catch (err: any) {
      return { error: `输入失败: ${err.message}`, selector };
    }
  }

  async handleScreenshot(args: Record<string, any>): Promise<any> {
    if (!this.isAvailable()) return { error: '浏览器未初始化' };
    const { selector } = args;
    try {
      let target = this.page;
      if (selector) {
        const element = await this.page.$(selector);
        if (!element) return { error: `元素未找到: ${selector}` };
        target = element;
      }
      const filename = `screenshot-${Date.now()}-${++this.screenshotCount}.png`;
      const savePath = this.screenshotsDir ? `${this.screenshotsDir}/${filename}` : filename;
      await target.screenshot({ path: savePath });
      return { path: savePath, filename, ok: true };
    } catch (err: any) {
      return { error: `截图失败: ${err.message}` };
    }
  }

  async handleExtract(args: Record<string, any>): Promise<any> {
    if (!this.isAvailable()) return { error: '浏览器未初始化' };
    const { selector, attribute } = args;
    try {
      const elements = await this.page.$$(selector);
      const results: string[] = [];
      for (const el of elements.slice(0, 20)) {
        if (attribute) {
          const val = await el.evaluate((e: any, a: string) => e.getAttribute(a), attribute);
          if (val) results.push(val);
        } else {
          const text = await el.evaluate((e: any) => e.textContent || e.innerText);
          if (text) results.push(text.trim());
        }
      }
      return { selector, attribute: attribute || 'text', count: results.length, results: results.slice(0, 10) };
    } catch (err: any) {
      return { error: `提取失败: ${err.message}`, selector };
    }
  }

  async handleExec(args: Record<string, any>): Promise<any> {
    if (!this.isAvailable()) return { error: '浏览器未初始化' };
    const { code } = args;
    try {
      const result = await this.page.evaluate(code);
      return { result: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result), ok: true };
    } catch (err: any) {
      return { error: `执行失败: ${err.message}` };
    }
  }

  // ── 导出 ──

  /** 获取所有浏览器工具定义 */
  static getToolDefinitions(): ToolDefinition[] {
    return [
      TOOL_BROWSER_OPEN,
      TOOL_BROWSER_CLICK,
      TOOL_BROWSER_TYPE,
      TOOL_BROWSER_SCREENSHOT,
      TOOL_BROWSER_EXTRACT,
      TOOL_BROWSER_EXEC,
    ];
  }

  /** 获取工具名 -> handler 映射 */
  getHandlers(): Record<string, (args: Record<string, any>) => Promise<any>> {
    return {
      'browser_open': (args) => this.handleOpen(args),
      'browser_click': (args) => this.handleClick(args),
      'browser_type': (args) => this.handleType(args),
      'browser_screenshot': (args) => this.handleScreenshot(args),
      'browser_extract': (args) => this.handleExtract(args),
      'browser_exec': (args) => this.handleExec(args),
    };
  }

  /** 关闭浏览器 */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      console.log('[Browser] 已关闭');
    }
  }
}
