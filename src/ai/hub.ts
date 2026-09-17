/**
 * AI Hub - AI 接入层 V2
 * 统一管理云端和本地模型
 * 支持：英伟达 NIM + OpenAI + Ollama + 自定义
 */
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─────────────────── 配置 ───────────────────

export interface AIProviderConfig {
  id: string;
  type: "nvidia" | "openai" | "ollama" | "anthropic" | "custom" | "deepseek" | "google" | "minimax" | "moonshot" | "zhipu" | "qwen" | "stepfun" | "siliconflow" | "groq" | "openrouter" | "llama-cpp" | "vllm" | "lm-studio" | "tgi" | "text-gen-webui" | "baidu" | "yi" | "baichuan" | "zero-one" | "mistral" | "cohere" | "together" | "fireworks" | "perplexity" | "01ai" | "sensetime" | "kunlun" | "iflytek" | "volcengine" | "tencent" | "huawei" | "xai" | "mistral-large" | "cloudflare";
  apiKey?: string;
  baseUrl?: string;
  models: string[];
  isLocal: boolean;
}

/**
 * 配置方式：
 *
 * 环境变量 / .env 文件：
 *    NVIDIA_API_KEY=nvapi-xxx           → 启用英伟达 NIM（推荐，免费额度）
 *    NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
 *    OPENAI_API_KEY=sk-xxx              → 启用 OpenAI
 *    OLLAMA_BASE_URL=http://localhost:11434/v1
 *    DEFAULT_MODEL=qwen/qwen3-next-80b-a3b-instruct
 *
 * 优先级：英伟达 > OpenAI > Ollama
 */

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

// 英伟达 NIM 推荐模型（支持 function calling + 中文）
// 英伟达 NIM 推荐模型（2026-09-13 全量实测 HTTP 200 复核）
// ⚠️ 旧列表已作废：minimaxai/minimax-m3(410 EOL)、z-ai/glm-5.2(410 EOL)、
//    stepfun-ai/step-3.7-flash(410 EOL)、moonshotai/kimi-k2.6(404 账号无授权)
// ⚠️ 注意：NIM 部分模型非流式请求会挂起，必须 stream:true（deepseek-v4-flash-0731 即属此类）
const NVIDIA_RECOMMENDED_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b",            // ⭐ 默认主模型
  "nvidia/nemotron-3-super-120b-a12b",            // Nemotron 3 Super
  "nvidia/nemotron-3.5-lightning-30b-a3b",        // Nemotron 3.5 轻量
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",// Nemotron Nano 推理
  "z-ai/glm-5.3-flash",                           // 智谱 GLM-5.3 Flash
  "openai/gpt-oss-20b",                           // GPT-OSS 20B 轻量推理
  "deepseek-ai/deepseek-v4-flash-0731",           // DeepSeek V4 Flash（需流式）
];

// 模型级黑名单持久化路径：记录「目录里有、但账号无授权 / 模型已下线」的模型，
// 防止 syncNvidiaModels() 反复把死模型灌回 providers。
const MODEL_BLACKLIST_PATH = join(process.cwd(), "data", "nvidia-model-blacklist.json");

/** 模型级黑名单条目 */
export interface ModelBlacklistEntry {
  model: string;
  status: number; // 触发拉黑的 HTTP 状态码（400/403/404/410/422）
  reason: string; // 服务端返回的原始错误摘要
  at: string;     // ISO 时间戳
  count: number;  // 累计命中次数
}

// 默认提供商配置
const DEFAULT_PROVIDERS: AIProviderConfig[] = [
  // ── 英伟达 NIM（最优先） ──
  {
    id: "nvidia-nim",
    type: "nvidia",
    apiKey: NVIDIA_API_KEY,
    baseUrl: NVIDIA_BASE_URL,
    models: NVIDIA_RECOMMENDED_MODELS,
    isLocal: false,
  },
  // ── OpenAI（备用） ──
  {
    id: "openai-cloud",
    type: "openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.6-luna-pro", "gpt-5.6-luna", "gpt-5.6-terra-pro", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    isLocal: false,
  },
  // ── Ollama（本地） ──
  {
    id: "local-ollama",
    type: "ollama",
    baseUrl: OLLAMA_BASE_URL,
    models: [], // 启动时动态拉取
    isLocal: true,
  },
  // ── DeepSeek ──
  {
    id: "deepseek",
    type: "deepseek",
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: DEEPSEEK_BASE_URL,
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    isLocal: false,
  },
  // ── 智谱 GLM ──
  {
    id: "zhipu",
    type: "zhipu",
    apiKey: process.env.ZHIPU_API_KEY || "",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.2", "glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.6", "glm-4.5", "glm-4-flash-250414", "glm-4v-flash"],
    isLocal: false,
  },
  // ── Kimi (Moonshot) ──
  {
    id: "moonshot",
    type: "moonshot",
    apiKey: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || "",
    baseUrl: "https://api.moonshot.cn/v1",  // 国内域名
    models: ["kimi-latest", "k3", "k3-instruct", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    isLocal: false,
  },
  // ── MiniMax ──
  {
    id: "minimax",
    type: "minimax",
    apiKey: process.env.MINIMAX_API_KEY || "",
    baseUrl: "https://api.minimax.io/v1",
    models: ["MiniMax-M3", "MiniMax-M3-Pro", "abab6.5-chat", "abab6.5s-chat", "minimax-m3"],
    isLocal: false,
  },
  // ── 通义千问 (Qwen) ──
  {
    id: "qwen",
    type: "qwen",
    apiKey: process.env.QWEN_API_KEY || "",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash", "qwen3.5-omni-plus", "qwen-max", "qwen-plus", "qwen-turbo", "qwen3-coder-plus"],
    isLocal: false,
  },
  // ── 百度文心 (千帆) ──
  {
    id: "baidu",
    type: "baidu",
    apiKey: process.env.BAIDU_API_KEY || "",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.0-turbo", "ernie-4.0", "ernie-3.5-turbo", "ernie-speed", "ernie-lite"],
    isLocal: false,
  },
  // ── 零一万物 (Yi) ──
  {
    id: "yi",
    type: "yi",
    apiKey: process.env.YI_API_KEY || "",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    models: ["yi-large", "yi-medium", "yi-spark", "yi-lightning"],
    isLocal: false,
  },
  // ── 百川 (Baichuan) ──
  {
    id: "baichuan",
    type: "baichuan",
    apiKey: process.env.BAICHUAN_API_KEY || "",
    baseUrl: "https://api.baichuan-ai.com/v1",
    models: ["Baichuan4", "Baichuan3-Turbo", "Baichuan2-Turbo"],
    isLocal: false,
  },
  // ── 阶跃星辰 (StepFun) ──
  {
    id: "stepfun",
    type: "stepfun",
    apiKey: process.env.STEPFUN_API_KEY || "",
    baseUrl: "https://api.stepfun.com/v1",
    models: ["step-3-8k", "step-3-32k", "step-3.7-flash", "step-1v-8k"],
    isLocal: false,
  },
  // ── SiliconFlow (硅基流动) ──
  {
    id: "siliconflow",
    type: "siliconflow",
    apiKey: process.env.SILICONFLOW_API_KEY || "",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen3-235B-A22B", "meta-llama/Meta-Llama-3.1-405B-Instruct", "deepseek-ai/deepseek-v4-flash"],
    isLocal: false,
  },
  // ── 讯飞星火 (Spark) ──
  {
    id: "iflytek",
    type: "iflytek",
    apiKey: process.env.IFLYTEK_API_KEY || "",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    models: ["spark-v4.0", "spark-v3.5", "spark-v3.1"],
    isLocal: false,
  },
  // ── 火山引擎 (豆包) ──
  {
    id: "volcengine",
    type: "volcengine",
    apiKey: process.env.VOLCENGINE_API_KEY || "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-pro-256k", "doubao-pro-128k", "doubao-pro-32k", "doubao-pro-4k", "doubao-lite-128k", "doubao-lite-32k", "doubao-lite-4k"],
    isLocal: false,
  },
  // ── 腾讯混元 ──
  {
    id: "tencent",
    type: "tencent",
    apiKey: process.env.TENCENT_API_KEY || "",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbo", "hunyuan-standard", "hunyuan-lite", "hunyuan-vision"],
    isLocal: false,
  },
  // ── Google Gemini ──
  {
    id: "google",
    type: "google",
    apiKey: process.env.GOOGLE_API_KEY || "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro", "gemini-1.5-flash"],
    isLocal: false,
  },
  // ── Anthropic Claude ──
  {
    id: "anthropic",
    type: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-5", "claude-sonnet-4", "claude-opus-4", "claude-3.5-haiku", "claude-3.5-sonnet"],
    isLocal: false,
  },
  // ── Groq ──
  {
    id: "groq",
    type: "groq",
    apiKey: process.env.GROQ_API_KEY || "",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    isLocal: false,
  },
  // ── Mistral ──
  {
    id: "mistral",
    type: "mistral",
    apiKey: process.env.MISTRAL_API_KEY || "",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-medium", "mistral-small", "codestral-latest", "pixtral-large-latest"],
    isLocal: false,
  },
  // ── xAI (Grok) ──
  {
    id: "xai",
    type: "xai",
    apiKey: process.env.XAI_API_KEY || "",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4.5", "grok-3", "grok-3-mini", "grok-2", "grok-2-vision"],
    isLocal: false,
  },
  // ── OpenRouter (聚合 300+ 模型) ──
  {
    id: "openrouter",
    type: "openrouter",
    apiKey: process.env.OPENROUTER_API_KEY || "",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free", "nvidia/nemotron-3.5-lightning:free", "minimax/minimax-m3", "liquid/lfm-2.5-2.6b:free", "meta-llama/llama-3.3-70b-instruct"],
    isLocal: false,
  },
  // ── Together AI ──
  {
    id: "together",
    type: "together",
    apiKey: process.env.TOGETHER_API_KEY || "",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    isLocal: false,
  },
  // ── Fireworks AI ──
  {
    id: "fireworks",
    type: "fireworks",
    apiKey: process.env.FIREWORKS_API_KEY || "",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/qwen2p5-72b-instruct"],
    isLocal: false,
  },
  // ── Perplexity ──
  {
    id: "perplexity",
    type: "perplexity",
    apiKey: process.env.PERPLEXITY_API_KEY || "",
    baseUrl: "https://api.perplexity.ai",
    models: ["llama-3.1-sonar-large-128k-online", "llama-3.1-sonar-small-128k-online"],
    isLocal: false,
  },
];


// ─────────────────── AI Hub ───────────────────

export class AIHub {
  private providers: Map<string, { client: OpenAI; config: AIProviderConfig }> = new Map();
  // P1-7: 简单熔断器
  private circuitBreaker = new Map<string, { failures: number; lastFail: number }>();
  private readonly CB_THRESHOLD = 5;
  private readonly CB_COOLDOWN = 60_000;
  // 不可重试的"配置类"错误：模型 ID 非法 / 已下线 / 无权限 / 区域封锁
  //   400 非法模型 ID（含 embedding 模型误走 chat）  401 Key 无效
  //   403 无权限/区域封锁   404 模型不存在或账号无授权   410 模型已 EOL 下线   422 参数不合法
  private readonly FATAL_STATUSES = new Set([400, 401, 403, 404, 410, 422]);
  // 模型级黑名单：与熔断器不同，这是「配置类」长期失效（无授权/EOL/非法 ID），需持久化且不自动恢复
  //   401 不拉黑（Key 问题，非模型问题）；403 拉黑（区域封锁是模型级的）
  private readonly BLACKLIST_STATUSES = new Set([400, 403, 404, 410, 422]);
  private modelBlacklist = new Map<string, ModelBlacklistEntry>();
  private blacklistLoaded = false;

  constructor() {
    for (const cfg of DEFAULT_PROVIDERS) {
      // 跳过没配置 key 的云端 provider
      if (!cfg.apiKey && !cfg.isLocal) continue;
      const baseURL = cfg.type === "nvidia" ? NVIDIA_BASE_URL : cfg.baseUrl;
      const apiKey = cfg["apiKey"] || "ollama-local"; // 本地 provider 用占位 key（不会真实使用）
      const client = new OpenAI({
        apiKey,
        baseURL,
      });
      this.providers.set(cfg.id, { client, config: cfg });
    }
    // 启动时加载持久化的模型黑名单（失败不阻塞启动）
    this.loadModelBlacklist();
  }

  /** 外部动态添加 Provider（从 UI 设置同步） */
  addProvider(cfg: AIProviderConfig) {
    const key = cfg["apiKey"] || "";
    // 本地模型不需要 API Key
    if (!key && !cfg.isLocal && cfg.type !== 'ollama' && cfg.type !== 'llama-cpp' && cfg.type !== 'vllm' && cfg.type !== 'lm-studio' && cfg.type !== 'tgi' && cfg.type !== 'custom') {
      console.warn(`[AI Hub] 跳过 Provider ${cfg.id}: 缺少 API Key`);
      return;
    }
    // 按 type 补默认 baseUrl，避免空地址 fallback 到 OpenAI
    const DEFAULT_URLS: Record<string, string> = {
      deepseek: 'https://api.deepseek.com/v1',
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      google: 'https://generativelanguage.googleapis.com/v1beta/openai',
      minimax: 'https://api.minimax.io/v1',
      moonshot: 'https://api.moonshot.cn/v1',
      zhipu: 'https://open.bigmodel.cn/api/paas/v4',
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      stepfun: 'https://api.stepfun.com/v1',
      siliconflow: 'https://api.siliconflow.cn/v1',
      groq: 'https://api.groq.com/openai/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      nvidia: 'https://integrate.api.nvidia.com/v1',
      ollama: 'http://localhost:11434/v1',
      'llama-cpp': 'http://localhost:8080/v1',
      vllm: 'http://localhost:8000/v1',
      'lm-studio': 'http://localhost:1234/v1',
      tgi: 'http://localhost:8080/v1',
      'text-gen-webui': 'http://localhost:5000/v1',
      // ── 国内云端 ──
      baidu: 'https://qianfan.baidubce.com/v2',
      yi: 'https://api.lingyiwanwu.com/v1',
      baichuan: 'https://api.baichuan-ai.com/v1',
      'zero-one': 'https://api.lingwan.cn/v1',
      '01ai': 'https://api.lingyiwanwu.com/v1',
      sensetime: 'https://api.sensetime.com/v1',
      kunlun: 'https://api.moonshot.cn/v1',
      iflytek: 'https://spark-api-open.xf-yun.com/v1',
      volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
      tencent: 'https://api.hunyuan.cloud.tencent.com/v1',
      huawei: 'https://pangu.huaweicloud.com/v1',
      // ── 国际云端 ──
      mistral: 'https://api.mistral.ai/v1',
      cohere: 'https://api.cohere.ai/v1',
      together: 'https://api.together.xyz/v1',
      fireworks: 'https://api.fireworks.ai/inference/v1',
      perplexity: 'https://api.perplexity.ai',
      xai: 'https://api.x.ai/v1',
      cloudflare: 'https://api.cloudflare.com/client/v4',
      custom: 'https://api.openai.com/v1',
    };
    const baseURL = cfg.baseUrl || DEFAULT_URLS[cfg.type] || 'https://api.openai.com/v1';
    const client = new OpenAI({
      apiKey: key || 'local',
      baseURL,
    });
    this.providers.set(cfg.id, { client, config: { ...cfg, baseUrl: baseURL } });
    console.log(`[AI Hub] 动态注册 Provider: ${cfg.id} (${(cfg.models || []).length} 模型, ${baseURL})`);
  }

  /** 移除一个 Provider */
  removeProvider(id: string): boolean {
    const existed = this.providers.has(id);
    this.providers.delete(id);
    if (existed) {
      console.log(`[AI Hub] 移除 Provider: ${id}`);
    }
    return existed;
  }

  /** 列出所有 Provider（给 UI 用） */
  listProviders() {
    return Array.from(this.providers.entries()).map(([id, entry]) => ({
      id,
      type: entry.config.type,
      name: id === 'nvidia-nim' ? 'NVIDIA NIM' : id === 'deepseek' ? 'DeepSeek V4' : id === 'local-ollama' ? 'Ollama (本地)' : entry.config.type,
      baseUrl: entry.config.baseUrl,
      models: entry.config.models,
      isLocal: entry.config.isLocal,
      enabled: true,
      hasKey: !!(entry.config.apiKey && entry.config.apiKey.length > 8 && !entry.config.apiKey.startsWith('your-')),
    }));
  }

  /**
   * 启动时动态拉取 Ollama 模型列表
   */
  async syncOllamaModels(): Promise<string[]> {
    const ollamaEntry = this.providers.get("local-ollama");
    if (!ollamaEntry) return [];

    try {
      const tagUrl = OLLAMA_BASE_URL.replace(/\/v1\/?$/, "") + "/api/tags";
      const res = await fetch(tagUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models: { name: string }[] };
      const models = (data.models || []).map((m) => m.name);
      ollamaEntry.config.models = models;
      if (models.length > 0) {
        console.log(`[AI Hub] Ollama 检测到 ${models.length} 个本地模型: ${models.join(", ")}`);
      } else {
        console.log("[AI Hub] Ollama 已连接但无模型");
      }
      return models;
    } catch {
      console.log("[AI Hub] Ollama 未连接，本地模型不可用");
      ollamaEntry.config.models = [];
      return [];
    }
  }

  // ─────────────────── 模型黑名单 ───────────────────

  /** 懒加载黑名单文件（幂等） */
  private loadModelBlacklist(): void {
    if (this.blacklistLoaded) return;
    this.blacklistLoaded = true;
    try {
      if (!existsSync(MODEL_BLACKLIST_PATH)) return;
      const raw = readFileSync(MODEL_BLACKLIST_PATH, "utf8");
      const arr = JSON.parse(raw) as ModelBlacklistEntry[];
      for (const e of arr) if (e && e.model) this.modelBlacklist.set(e.model, e);
      if (this.modelBlacklist.size) {
        console.log(`[AI Hub] 已加载模型黑名单 ${this.modelBlacklist.size} 条: ${[...this.modelBlacklist.keys()].join(", ")}`);
      }
    } catch (err: any) {
      console.warn(`[AI Hub] 模型黑名单加载失败: ${err.message}`);
    }
  }

  /** 写回黑名单文件 */
  private persistModelBlacklist(): void {
    try {
      mkdirSync(dirname(MODEL_BLACKLIST_PATH), { recursive: true });
      const arr = [...this.modelBlacklist.values()].sort((a, b) => a.model.localeCompare(b.model));
      writeFileSync(MODEL_BLACKLIST_PATH, JSON.stringify(arr, null, 2), "utf8");
    } catch (err: any) {
      console.warn(`[AI Hub] 模型黑名单保存失败: ${err.message}`);
    }
  }

  /** 判断模型是否在黑名单（支持归一化匹配，裸名 ↔ 带 :free 后缀可互相命中） */
  isModelBlacklisted(model: string): boolean {
    this.loadModelBlacklist();
    if (!model) return false;
    if (this.modelBlacklist.has(model)) return true;
    const norm = this.normalizeModelName(model);
    if (norm && norm !== model && this.modelBlacklist.has(norm)) return true;
    for (const key of this.modelBlacklist.keys()) {
      if (this.normalizeModelName(key) === norm) return true;
    }
    return false;
  }

  /** 记录一次「配置类」模型失败；命中即拉黑并落盘 */
  recordModelFailure(model: string, status: number, reason: string): void {
    if (!model || !this.BLACKLIST_STATUSES.has(status)) return;
    this.loadModelBlacklist();
    const prev = this.modelBlacklist.get(model);
    const entry: ModelBlacklistEntry = {
      model,
      status,
      reason: String(reason || "").slice(0, 200),
      at: new Date().toISOString(),
      count: (prev?.count || 0) + 1,
    };
    this.modelBlacklist.set(model, entry);
    this.persistModelBlacklist();
    console.warn(`[AI Hub] 模型已加入黑名单 (HTTP ${status}, 命中${entry.count}次): ${model}`);
  }

  /** 手动将模型移出黑名单 */
  unblacklistModel(model: string): boolean {
    this.loadModelBlacklist();
    const ok = this.modelBlacklist.delete(model);
    if (ok) this.persistModelBlacklist();
    return ok;
  }

  /** 查看当前黑名单快照 */
  getModelBlacklist(): ModelBlacklistEntry[] {
    this.loadModelBlacklist();
    return [...this.modelBlacklist.values()];
  }

  /**
   * 动态拉取英伟达可用模型（可选，验证 API 连通性）
   */
  async syncNvidiaModels(): Promise<string[]> {
    const nvidiaEntry = this.providers.get("nvidia-nim");
    if (!nvidiaEntry || !nvidiaEntry.config.apiKey) return [];

    try {
      // 仅验证连通性，按需拉取完整列表
      const res = await fetch(NVIDIA_BASE_URL.replace(/\/v1\/?$/, "") + "/v1/models", {
        headers: { "Authorization": `Bearer ${nvidiaEntry.config.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data: { id: string }[] };
      const allModels = (data.data || []).map(m => m.id);
      console.log(`[AI Hub] NVIDIA NIM 连通，共 ${allModels.length} 个可用模型`);

      // 用推荐列表过滤，只保留推荐模型（已验证支持 function calling）
      const available = NVIDIA_RECOMMENDED_MODELS.filter(m => allModels.includes(m) && !this.isModelBlacklisted(m));
      // 黑名单模型（目录里有但实测无授权/已下线）单独打印，便于排查
      const blocked = NVIDIA_RECOMMENDED_MODELS.filter(m => allModels.includes(m) && this.isModelBlacklisted(m));
      if (blocked.length) console.log(`[AI Hub] 已跳过黑名单模型 ${blocked.length} 个: ${blocked.join(", ")}`);
      if (available.length > 0) {
        nvidiaEntry.config.models = available;
        console.log(`[AI Hub] NVIDIA NIM 推荐模型可用: ${available.join(", ")}`);
      } else {
        // 如果推荐模型不在列表里，用完整列表里的 instruct 模型
        // 过滤出对话类模型，剔除 embedding/rerank/reward/guard/vision 等非对话模型
        const instructModels = allModels
          .filter(m => /instruct|chat|glm|qwen|minimax|deepseek|nemotron/.test(m))
          .filter(m => !/embed|rerank|reward|guard|safety|parse|clip|detector|deplot|translate|calibration|fuyu|kosmos|vila|neva|video|visual/i.test(m))
          .filter(m => !this.isModelBlacklisted(m))
          .slice(0, 8);
        if (instructModels.length > 0) {
          nvidiaEntry.config.models = instructModels;
          console.log(`[AI Hub] NVIDIA NIM 自动选择: ${instructModels.join(", ")}`);
        }
      }
      return nvidiaEntry.config.models;
    } catch (err: any) {
      console.log(`[AI Hub] NVIDIA NIM 连接失败: ${err.message}`);
      // 保持推荐列表不变（API 可用但模型列表接口可能有变化）
      return nvidiaEntry.config.models;
    }
  }

  /**
   * 规范化模型名：剥离 :cloud / :local 后缀，以及 xxx-ai/ / xxx/ 前缀
   * 这样用户在 UI 里选 "glm-5.2:cloud" 也能正确匹配到 zhipu provider 的 "glm-5.2"
   */
  private normalizeModelName(model: string): string {
    // 剥离供应商/聚合器后缀：:cloud :local :latest :free :batch :thinking :nitro :online 等
    // 说明：OpenRouter 免费模型形如 "vendor/model:free"，需能被正确归一化匹配
    let normalized = model.replace(/:(cloud|local|latest|free|batch|thinking|nitro|online|extended|floor|auto)$/i, "");
    // 剥离命名空间前缀：xxx/ 或 xxx-ai/（仅剥一层；剥完为空则保留原值）
    const stripped = normalized.replace(/^[a-z0-9][a-z0-9._-]*\//i, "");
    if (stripped) normalized = stripped;
    return normalized;
  }

  /**
   * 获取可用的 AI 客户端
   * 匹配顺序：精确 → 规范化后精确 → 模糊 → fallback
   */
  getClient(model: string): { client: OpenAI; resolvedModel: string } | null {
    // 0. 空模型名兜底
    if (!model) {
      const defaultModel = this.getDefaultModel();
      if (defaultModel) {
        return this.getClient(defaultModel);
      }
      const first = this.providers.values().next().value;
      return first ? { client: first.client, resolvedModel: first.config.models[0] || "" } : null;
    }

    // 1. 精确匹配
    for (const [, entry] of this.providers) {
      if (entry.config.models.some(m => model === m)) {
        return { client: entry.client, resolvedModel: model };
      }
    }

    // 2. 规范化后精确匹配（剥离 :cloud/:local 后缀 + xxx/ 前缀）
    // 修复：原代码使用了不存在的变量 matchModel，导致 ReferenceError 崩溃
    const strippedModel = this.normalizeModelName(model);
    if (strippedModel !== model) {
      for (const [, entry] of this.providers) {
        if (entry.config.models.some(m => strippedModel === m)) {
          return { client: entry.client, resolvedModel: strippedModel };
        }
      }
      // 也尝试用规范化后的名字做模糊匹配
      for (const [, entry] of this.providers) {
        if (entry.config.models.some(m => strippedModel.includes(m) || m.includes(strippedModel))) {
          const matchedModel = entry.config.models.find(m => strippedModel.includes(m) || m.includes(strippedModel));
          return { client: entry.client, resolvedModel: matchedModel || strippedModel };
        }
      }
    }

    // 3. provider id 与模型名有共同前缀的优先（避免 deepseek-ai/ 抢 deepseek 的模型）
    for (const [pid, entry] of this.providers) {
      if (entry.config.models.some(m => model.includes(m) || m.includes(model))) {
        if (model.toLowerCase().includes(pid.toLowerCase()) || pid.toLowerCase().includes(model.split("-")[0])) {
          const matchedModel = entry.config.models.find(m => model.includes(m) || m.includes(model));
          return { client: entry.client, resolvedModel: matchedModel || model };
        }
      }
    }

    // 4. 最后模糊匹配兜底
    for (const [, entry] of this.providers) {
      const matchedModel = entry.config.models.find(m => model.includes(m) || m.includes(model));
      if (matchedModel) {
        return { client: entry.client, resolvedModel: matchedModel };
      }
    }

    // 5. fallback: 英伟达 → Ollama → 第一个 provider
    for (const [, entry] of this.providers) {
      if (entry.config.type === "nvidia" && entry.config.models.length > 0) {
        const fallbackModel = entry.config.models[0];
        console.log(`[AI Hub] 模型 "${model}" 不可用，fallback 到 NVIDIA: ${fallbackModel}`);
        return { client: entry.client, resolvedModel: fallbackModel };
      }
    }
    for (const [, entry] of this.providers) {
      if (entry.config.isLocal && entry.config.models.length > 0) {
        const fallbackModel = entry.config.models[0];
        console.log(`[AI Hub] 模型 "${model}" 不可用，fallback 到本地: ${fallbackModel}`);
        return { client: entry.client, resolvedModel: fallbackModel };
      }
    }

    // 6. 最后兜底
    const first = this.providers.values().next().value;
    return first ? { client: first.client, resolvedModel: first.config.models[0] || model } : null;
  }

  /**
   * Provider 级故障转移候选：同模型、排除故障 provider、跳过熔断中的备胎
   * 与 feature/add-ci 的"跨模型降级"版不同——verify-failover 场景6 契约
   * 要求未知模型返回空候选，故只做严格同模型匹配。
   */
  getFailoverCandidates(model: string, failedBaseUrl?: string, failedClient?: OpenAI): { client: OpenAI; resolvedModel: string }[] {
    const candidates: { client: OpenAI; resolvedModel: string }[] = [];
    const stripped = this.normalizeModelName(model);
    for (const [pid, entry] of this.providers) {
      if (failedBaseUrl && entry.config.baseUrl === failedBaseUrl) continue;
      if (failedClient && entry.client === failedClient) continue;
      const matched = entry.config.models.find(m => model === m || stripped === m || model.includes(m) || m.includes(model));
      if (!matched) continue;
      const cbState = this.circuitBreaker.get(matched);
      if (cbState && cbState.failures >= this.CB_THRESHOLD && (Date.now() - cbState.lastFail) < this.CB_COOLDOWN) {
        console.log(`[AI Hub] 故障转移候选 ${pid} 熔断器开启中，跳过`);
        continue;
      }
      candidates.push({ client: entry.client, resolvedModel: matched });
    }
    return candidates;
  }

  /**
   * 获取特定角色的 AI 客户端（多模型协作）
   * role: 'tool'（工具调用/摘要/压缩）| 'reply'（最终回复）| 'default'
   */
  getRoleClient(role: 'tool' | 'reply' | 'default' = 'default'): { client: OpenAI; resolvedModel: string } | null {
    const enabled = process.env.ROUTE_ENABLED !== 'false';
    if (!enabled) {
      // v1.9.6: 路由关闭 → 直接用 DEFAULT_MODEL，不做任何花活
      const model = this.getDefaultModel();
      const result = model ? this.getClient(model) : null;
      if (result) return result;
      // DEFAULT_MODEL 找不到 provider → 兜底到任意可用 provider
      console.warn(`[AIHub] 路由关闭但默认模型 "${model}" 无可用 provider，尝试兜底`);
      return this.getClient('');
    }
    const envKey = role === 'tool' ? 'TOOL_MODEL' : role === 'reply' ? 'REPLY_MODEL' : '';
    let model: string;
    if (envKey && process.env[envKey]) {
      model = process.env[envKey];
    } else if (role === 'tool') {
      // P1-1 修复：未设置 TOOL_MODEL 时，自动选择轻量模型
      model = this.getLightweightModel();
    } else {
      model = this.getDefaultModel();
    }
    const result = this.getClient(model);
    if (result && result.resolvedModel !== model) {
      console.warn(`[AIHub] getRoleClient(${role}): 请求 ${model} → 实际 ${result.resolvedModel} (模型名不匹配，可能是 provider 未配置 API Key 或模型名不在列表中)`);
    } else if (!result) {
      console.error(`[AIHub] getRoleClient(${role}): 模型 ${model} 完全不可用，无 fallback`);
    }
    return result;
  }

  /**
   * P1-1: 获取轻量模型（用于工具调用/摘要/压缩）
   */
  private getLightweightModel(): string {
    const allModels = this.listModels();
    const lightKeywords = ['flash', 'mini', 'small', 'lite', 'turbo', 'haiku', '8b', '9b', '20b'];
    for (const kw of lightKeywords) {
      const found = allModels.find(m => m.id.toLowerCase().includes(kw));
      if (found) {
        console.log(`[AIHub] 自动选择轻量工具模型: ${found.id} (匹配 ${kw})`);
        return found.id;
      }
    }
    return this.getDefaultModel();
  }

  /**
   * 列出所有可用模型
   */
  listModels(): { id: string; provider: string; isLocal: boolean }[] {
    const result: { id: string; provider: string; isLocal: boolean }[] = [];
    for (const [providerId, entry] of this.providers) {
      for (const model of entry.config.models) {
        result.push({ id: model, provider: providerId, isLocal: entry.config.isLocal });
      }
    }
    return result;
  }

  /**
   * 获取默认模型名
   */
  getDefaultModel(): string {
    if (process.env.DEFAULT_MODEL) return process.env.DEFAULT_MODEL;
    // 优先英伟达
    for (const [, entry] of this.providers) {
      if (entry.config.type === "nvidia" && entry.config.models.length > 0) {
        return entry.config.models[0];
      }
    }
    // 然后 Ollama
    for (const [, entry] of this.providers) {
      if (entry.config.isLocal && entry.config.models.length > 0) {
        const toolCapable = entry.config.models.find(m => /^(llama|qwen)/.test(m));
        return toolCapable || entry.config.models[0];
      }
    }
    // 兜底
    for (const [, entry] of this.providers) {
      if (entry.config.models.length > 0) return entry.config.models[0];
    }
    return "";
  }

  /**
   * 设置默认模型名
   */
  setDefaultModel(model: string): void {
    process.env.DEFAULT_MODEL = model;
  }

  /**
   * 生成回复（非流式）
   */
  async generate(request: {
    model: string;
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number } }> {
    const result = this.getClient(request.model);
    if (!result) {
      throw new Error(`找不到模型 ${request.model}，且无可用 fallback。请检查：1) NVIDIA_API_KEY / OPENAI_API_KEY  2) Ollama 是否启动`);
    }
    const { client, resolvedModel } = result;
    // 记录主 client 对应的 provider baseUrl，供故障转移排除用
    let failedBaseUrl: string | undefined;
    for (const [, entry] of this.providers) {
      if (entry.client === client) { failedBaseUrl = entry.config.baseUrl; break; }
    }

    // P1-7: 熔断器检查 — 连续失败过多时快速失败
    const cbKey = resolvedModel;
    const cbState = this.circuitBreaker.get(cbKey);
    if (cbState && cbState.failures >= this.CB_THRESHOLD) {
      const elapsed = Date.now() - cbState.lastFail;
      if (elapsed < this.CB_COOLDOWN) {
        throw new Error(`熔断器开启: ${resolvedModel} 连续失败 ${cbState.failures} 次，冷却中(${Math.ceil((this.CB_COOLDOWN - elapsed) / 1000)}s)`);
      }
      // 冷却期已过，半开放：允许一次尝试
      cbState.failures = this.CB_THRESHOLD - 1;
    }

    // 指数退避 + 熔断器
    const MAX_RETRIES = 3;
    let lastError: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
          console.log(`[AI Hub] 重试 ${request.model} (${attempt}/${MAX_RETRIES}) — 等待 ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        }
        const response = await client.chat.completions.create({
          model: resolvedModel,
          messages: request.messages as any,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 16384,
        });

        const choice = response.choices[0];
        // P1-7: 成功 → 重置熔断器
        this.circuitBreaker.delete(cbKey);
        return {
          content: choice.message.content || "",
          usage: response.usage
            ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens ?? 0,
              }
            : undefined,
        };
      } catch (error: any) {
        lastError = error;
        // P1-2 修复：429 限流是临时错误，不计入熔断器
        if (error.status !== 429) {
          const cb = this.circuitBreaker.get(cbKey) || { failures: 0, lastFail: 0 };
          cb.failures++;
          cb.lastFail = Date.now();
          this.circuitBreaker.set(cbKey, cb);
        }
        // 不可重试的"配置类"错误直接抛（400/401/403/404/410/422）
        // 旧逻辑只拦 401/403/404，导致 400(非法ID)、410(已下线) 被白重试 3 次 + 指数退避
        if (this.FATAL_STATUSES.has(error.status)) {
          console.error(`[AI Hub] 不可重试的错误 (${request.model}, HTTP ${error.status}):`, error.message);
          // 持久化模型级黑名单：400/403/404/410/422 代表模型本身不可用，避免下次再被 sync 灌回
          this.recordModelFailure(resolvedModel, error.status, error.message);
          throw new Error(`AI 生成失败(HTTP ${error.status}，模型 ID 可能非法或已下线，请检查 providers.json): ${error.message}`);
        }
        // 备胎接管尝试：任一候选成功即返回，全部失败返回 null 由调用方抛错
        const tryFailover = async (reason: string) => {
          const candidates = this.getFailoverCandidates(request.model, failedBaseUrl, client);
          for (const cand of candidates) {
            try {
              console.log(`[AI Hub] 故障转移 → 备胎 provider ${cand.resolvedModel} (${reason})`);
              const resp = await cand.client.chat.completions.create({
                model: cand.resolvedModel,
                messages: request.messages as any,
                temperature: request.temperature ?? 0.7,
                max_tokens: request.maxTokens ?? 16384,
              });
              this.circuitBreaker.delete(cand.resolvedModel);
              console.log(`[AI Hub] 备胎接管成功 (${cand.resolvedModel})`);
              return {
                content: resp.choices[0].message.content || "",
                usage: resp.usage
                  ? { promptTokens: resp.usage.prompt_tokens, completionTokens: resp.usage.completion_tokens ?? 0 }
                  : undefined,
              };
            } catch (fe: any) {
              console.error(`[AI Hub] 备胎失败 (${cand.resolvedModel}):`, fe.message);
              lastError = fe;
            }
          }
          return null;
        };
        // 402 余额不足：对同一 provider 重试毫无意义，跳过指数退避立即故障转移
        // （402 不在 FATAL_STATUSES/BLACKLIST_STATUSES 中，不会误入模型黑名单）
        if (error.status === 402) {
          console.error(`[AI Hub] 402 余额不足 (${request.model})，立即故障转移`);
          const rescued = await tryFailover('402 快速转移');
          if (rescued) return rescued;
          throw new Error(`AI 生成失败(主与备胎均失败): ${error.message}`);
        }
        if (attempt >= MAX_RETRIES) {
          console.error(`[AI Hub] 重试耗尽 (${request.model}):`, error.message);
          const rescued = await tryFailover('重试耗尽');
          if (rescued) return rescued;
          throw new Error(`AI 生成失败(已重试${MAX_RETRIES}次): ${error.message}`);
        }
      }
    }
    throw lastError;
  }
}