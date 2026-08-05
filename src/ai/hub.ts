/**
 * AI Hub - AI 接入层 V2
 * 统一管理云端和本地模型
 * 支持：英伟达 NIM + OpenAI + Ollama + 自定义
 */
import OpenAI from "openai";

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
const NVIDIA_RECOMMENDED_MODELS = [
  "minimaxai/minimax-m3",                 // ⭐ 默认主模型
  "minimaxai/minimax-m2.7",               // MiniMax 上代
  "z-ai/glm-5.2",                         // 智谱 GLM-5.2
  "moonshotai/kimi-k2.6",                 // Kimi K2.6 多模态 MoE
  "stepfun-ai/step-3.7-flash",            // StepFun 3.7 Flash
  "stepfun-ai/step-3.5-flash",            // StepFun 3.5 Flash
  "qwen/qwen3-next-80b-a3b-instruct",    // Qwen3 80B 中文+工具调用强
  "qwen/qwen3.5-122b-a10b",              // Qwen 3.5 122B
  "qwen/qwen3.5-397b-a17b",              // Qwen 3.5 397B 大参数
  "deepseek-ai/deepseek-v4-flash",        // DeepSeek V4 Flash
  "deepseek-ai/deepseek-v4-pro",          // DeepSeek V4 Pro
  "openai/gpt-oss-120b",                  // GPT-OSS 120B 推理
  "openai/gpt-oss-20b",                   // GPT-OSS 20B 轻量推理
  "google/gemma-4-31b-it",               // Gemma 4 31B
];

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
    models: ["z-ai/glm-5.2", "openai/gpt-5.6-luna-pro", "anthropic/claude-sonnet-5", "google/gemini-3.1-flash-image", "google/gemini-3-pro-image", "x-ai/grok-4.5", "moonshotai/kimi-k2.7-code", "tencent/hy3", "meta-llama/llama-3.3-70b-instruct"],
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
    // 自动设置默认模型：首个注册的 provider 的首个模型
    if (!this.getDefaultModel() && cfg.models.length > 0) {
      this.setDefaultModel(cfg.models[0]);
      console.log(`[AI Hub] 自动设置默认模型: ${cfg.models[0]} (来自 ${cfg.id})`);
    }
    console.log(`[AI Hub] 动态注册 Provider: ${cfg.id} (${cfg.models.length} 模型, ${baseURL})`);
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
      const available = NVIDIA_RECOMMENDED_MODELS.filter(m => allModels.includes(m));
      if (available.length > 0) {
        nvidiaEntry.config.models = available;
        console.log(`[AI Hub] NVIDIA NIM 推荐模型可用: ${available.join(", ")}`);
      } else {
        // 如果推荐模型不在列表里，用完整列表里的 instruct 模型
        const instructModels = allModels.filter(m => /instruct|chat|glm|qwen|minimax|deepseek/.test(m)).slice(0, 8);
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
   * 获取可用的 AI 客户端
   * 匹配顺序：精确 → 模糊 → fallback
   */
  getClient(model: string): { client: OpenAI; resolvedModel: string } | null {
    // 1. 精确匹配
    for (const [, entry] of this.providers) {
      if (entry.config.models.some(m => model === m)) {
        return { client: entry.client, resolvedModel: model };
      }
    }

    // 2. 模糊匹配（优先匹配 provider id 与模型前缀一致的，避免 deepseek-ai/ 抢 deepseek 的模型）
    // 先尝试：模型名去掉 "xxx-ai/" 前缀后精确匹配
    const strippedModel = model.replace(/^[a-z]+-ai\//, "");
    for (const [, entry] of this.providers) {
      if (entry.config.models.some(m => strippedModel === m)) {
        return { client: entry.client, resolvedModel: strippedModel };
      }
    }
    // 再尝试：provider id 与模型名有共同前缀的优先
    for (const [pid, entry] of this.providers) {
      if (entry.config.models.some(m => model.includes(m) || m.includes(model))) {
        // 如果模型名包含 provider id（如 deepseek-v4-flash 包含 deepseek），优先走这个
        if (model.toLowerCase().includes(pid.toLowerCase()) || pid.toLowerCase().includes(model.split("-")[0])) {
          return { client: entry.client, resolvedModel: model.includes(pid) ? model : entry.config.models.find(m => model.includes(m) || m.includes(model)) || model };
        }
      }
    }
    // 最后模糊匹配兜底
    for (const [, entry] of this.providers) {
      if (entry.config.models.some(m => model.includes(m) || m.includes(model))) {
        return { client: entry.client, resolvedModel: model };
      }
    }

    // 3. fallback: 英伟达 → Ollama → 第一个 provider
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

    // 4. 最后兜底：遍历所有 provider，找到第一个有模型的就用，resolvedModel 用原始请求的模型名
    for (const [pid, entry] of this.providers) {
      if (entry.config.models.length > 0) {
        console.log(`[AI Hub] 模型 "${model}" 无精确匹配，使用 provider ${pid} 的 client，模型名透传: ${model}`);
        return { client: entry.client, resolvedModel: model };
      }
    }
    // 5. 实在没有，用第一个 provider 的 client + 原始模型名
    const first = this.providers.values().next().value;
    if (first) {
      console.log(`[AI Hub] 模型 "${model}" 无匹配，使用第一个 provider ${first.config.id} 透传模型名`);
      return { client: first.client, resolvedModel: model };
    }
    return null;
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
    const model = envKey ? (process.env[envKey] || this.getDefaultModel()) : this.getDefaultModel();
    return this.getClient(model);
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
        // 不可重试的错误直接抛
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          console.error(`[AI Hub] 不可重试的错误 (${request.model}):`, error.message);
          throw new Error(`AI 生成失败: ${error.message}`);
        }
        if (attempt >= MAX_RETRIES) {
          console.error(`[AI Hub] 重试耗尽 (${request.model}):`, error.message);
          throw new Error(`AI 生成失败(已重试${MAX_RETRIES}次): ${error.message}`);
        }
      }
    }
    throw lastError;
  }
}
