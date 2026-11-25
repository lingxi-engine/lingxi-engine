/**
 * AI Hub - AI 接入层 V2
 * 统一管理云端和本地模型
 * 支持：英伟达 NIM + OpenAI + Ollama + 自定义
 */
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { computeDelayMs, DEFAULT_RETRY_BUDGET } from "../core/retry-coordinator.js";
import { dataPath } from '../core/paths.js';
import { ModelHealthCache, probeModelHealth, isTimeoutLikeError, type ProbeResult } from "./model-health.js";

// ─────────────────── 配置 ───────────────────

/** patch-v20:applied — 解析结果（带来源标记，供「模型归属可见化」使用） */
export interface AIResolvedClient {
  client: OpenAI;
  resolvedModel: string;
  /** 实际服务的 provider id */
  providerId?: string;
  /** provider 是否为本机 daemon（注意：经本机转发的云端模型也会是 true，见 viaLocalDaemon） */
  isLocal?: boolean;
  /** patch-v22:applied true = 经本机 Ollama daemon 转发，但推理发生在远端（:cloud / -cloud 后缀） */
  viaLocalDaemon?: boolean;
  /** patch-v22:applied true = 推理真在本机 CPU/GPU 上跑（慢，是"跑到本地模型"的真正含义） */
  realLocal?: boolean;
  /** true = 请求的模型未被精确命中，属降级结果 */
  degraded?: boolean;
}

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
const MODEL_BLACKLIST_PATH = dataPath('nvidia-model-blacklist.json');

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
    models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
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
      models: ["nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free", "nvidia/nemotron-3.5-lightning:free", "minimax/minimax-m3", "liquid/lfm-2.5-2.6b:free", "meta-llama/llama-3.3-70b-instruct", "mistralai/mistral-large-4-1t-a52b"],
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
  // 反向索引：模型名 -> provider 条目数组（按优先级排序：非本地优先）
  private modelIndex: Map<string, { pid: string; entry: { client: OpenAI; config: AIProviderConfig }; isLocal: boolean }[]> = new Map();
  private indexBuilt = false;
  
  // P1-7: 简单熔断器
  private circuitBreaker = new Map<string, { failures: number; lastFail: number }>();
  private readonly CB_THRESHOLD = 5;
  private readonly CB_COOLDOWN = 60_000;
  /** v2.0.46: 模型健康缓存 —— 超时/挂死的「幽灵模型」首次超时即标记，TTL 内快速排除（补熔断器需 5 次失败的空窗） */
  readonly modelHealth = new ModelHealthCache();
  // 不可重试的"配置类"错误：模型 ID 非法 / 已下线 / 无权限 / 区域封锁
  //   400 非法模型 ID（含 embedding 模型误走 chat）  401 Key 无效
  //   403 无权限/区域封锁   404 模型不存在或账号无授权   410 模型已 EOL 下线   422 参数不合法
  // 402 Payment Required（余额/额度耗尽）同样不可重试：重试只会把余额烧得更干净
  private readonly FATAL_STATUSES = new Set([400, 401, 402, 403, 404, 410, 422]);
  // 模型级黑名单：与熔断器不同，这是「配置类」长期失效（无授权/EOL/非法 ID），需持久化且不自动恢复
  //   401 不拉黑（Key 问题，非模型问题）；403 拉黑（区域封锁是模型级的）
  private readonly BLACKLIST_STATUSES = new Set([400, 402, 403, 404, 410, 422]);
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
          timeout: 120000, // 2min 硬上限：避免挂死请求拖到 SDK 默认 10min
          maxRetries: 1, // 降低重试：挂死请求不做二次放大
        });
        this.providers.set(cfg.id, { client, config: cfg });
      }
      // 启动时加载持久化的模型黑名单（失败不阻塞启动）
      this.loadModelBlacklist();
      // 建立模型反向索引
      this.buildModelIndex();
    }

    /** 建立/重建模型名 -> provider 反向索引（单次遍历，O(总模型数)） */
    private buildModelIndex(): void {
      this.modelIndex.clear();
      for (const [pid, entry] of this.providers) {
        const isLocal = entry.config.isLocal;
        for (const model of entry.config.models) {
          if (!model) continue;
          const list = this.modelIndex.get(model) || [];
          list.push({ pid, entry, isLocal });
          this.modelIndex.set(model, list);
        }
      }
      // 每个模型的列表按：非本地优先、然后按 provider 优先级排序
      for (const [model, list] of this.modelIndex) {
        list.sort((a, b) => {
          if (a.isLocal !== b.isLocal) return a.isLocal ? 1 : -1; // 非本地优先
          return 0;
        });
      }
      this.indexBuilt = true;
    }

    /** 外部动态添加 Provider 时增量更新索引 */
      private updateModelIndexForProvider(pid: string, config: AIProviderConfig): void {
        const isLocal = config.isLocal;
        const entry = this.providers.get(pid);
        if (!entry) return;
        for (const model of config.models) {
          if (!model) continue;
          const list = this.modelIndex.get(model) || [];
          // 移除旧的同 provider 条目（避免重复）
          const filtered = list.filter(x => x.pid !== pid);
          filtered.push({ pid, entry, isLocal });
          filtered.sort((a, b) => {
            if (a.isLocal !== b.isLocal) return a.isLocal ? 1 : -1;
            return 0;
          });
          this.modelIndex.set(model, filtered);
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
      timeout: 120000, // 2min 硬上限：避免挂死请求拖到 SDK 默认 10min
      maxRetries: 1, // 降低重试：挂死请求不做二次放大
    });
    this.providers.set(cfg.id, { client, config: { ...cfg, baseUrl: baseURL } });
        // 增量更新模型索引
        this.updateModelIndexForProvider(cfg.id, { ...cfg, baseUrl: baseURL });
        console.log(`[AI Hub] 动态注册 Provider: ${cfg.id} (${(cfg.models || []).length} 模型, ${baseURL})`);
      }

      /** 移除一个 Provider */
      removeProvider(id: string): boolean {
        const existed = this.providers.has(id);
        this.providers.delete(id);
        // 从索引中移除
        if (existed) {
          for (const [model, list] of this.modelIndex) {
            const filtered = list.filter(x => x.pid !== id);
            if (filtered.length === 0) {
              this.modelIndex.delete(model);
            } else {
              this.modelIndex.set(model, filtered);
            }
          }
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
        // 重建索引以包含新的 Ollama 模型
        this.buildModelIndex();
        return models;
      } catch {
        console.log("[AI Hub] Ollama 未连接，本地模型不可用");
        ollamaEntry.config.models = [];
        this.buildModelIndex();
        return [];
      }
    }

  // ─────────────────── 模型黑名单 ───────────────────

    /**
     * 加载黑名单文件。
     * 2026-11-11 FIX：原来是 async 懒加载 + `blacklistLoaded=true` 提前置位，
     * 首个请求会在黑名单还没读进来时就把 39 个 glm-5.2:cloud 的 Agent 全放进 429 重试风暴
     * （每次 3 次重试 + 退避）。改成同步读盘（文件几 KB，启动时一次成本可忽略）。
     /** 加载黑名单文件（幂等） */
     private loadModelBlacklist(): Promise<void> {
      if (this.blacklistLoaded) return Promise.resolve();
      this.blacklistLoaded = true;
      try {
        // 2026-11-11 FIX：原来这里写 `require('fs')`，但项目是 ESM（package.json type=module），
        // 运行时直接抛 "require is not defined" → 黑名单永远加载不进来，
        // 39 个 glm-5.2:cloud 的 Agent 每次都白跑一遍 429 重试风暴。
        // 文件顶部已经 import { readFileSync, existsSync }，直接用。
        if (existsSync(MODEL_BLACKLIST_PATH)) {
          const arr = JSON.parse(readFileSync(MODEL_BLACKLIST_PATH, "utf8")) as ModelBlacklistEntry[];
          for (const e of arr) if (e && e.model) this.modelBlacklist.set(e.model, e);
          if (this.modelBlacklist.size) {
            console.log(`[AI Hub] 已加载模型黑名单 ${this.modelBlacklist.size} 条: ${[...this.modelBlacklist.keys()].join(", ")}`);
          }
        }
      } catch (err: any) {
        console.warn(`[AI Hub] 模型黑名单加载失败: ${err.message}`);
      }
      return Promise.resolve();
    }

    /** 写回黑名单文件（异步，批量） */
    private persistModelBlacklist(): void {
      // 异步写入，不阻塞
      (async () => {
        try {
          const { writeFile, mkdir } = await import('fs/promises');
          const { dirname } = await import('path');
          await mkdir(dirname(MODEL_BLACKLIST_PATH), { recursive: true });
          const arr = [...this.modelBlacklist.values()].sort((a, b) => a.model.localeCompare(b.model));
          await writeFile(MODEL_BLACKLIST_PATH, JSON.stringify(arr, null, 2), "utf8");
        } catch (err: any) {
          console.warn(`[AI Hub] 模型黑名单保存失败: ${err.message}`);
        }
      })();
    }

  /** 判断模型是否在黑名单（支持归一化匹配，裸名 ↔ 带 :free 后缀可互相命中） */
    isModelBlacklisted(model: string): boolean {
      // 同步检查内存中的黑名单（异步加载已在后台触发）
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
      // 触发异步加载（如果还没加载）
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
  /**
   * patch-v22:applied 归一化包装：区分「本机 daemon 转发」与「真本机推理」，并支持严格模型模式。
   * 语义修正：glm-5.2:cloud / kimi-k2.7-code:cloud 等后缀是 Ollama 云端中继壳，
   * 推理在远端进行，不应等同于"跑到了本地模型"（旧代码把它们都标成 isLocal=true，误导排查）。
   */
  getClient(model: string): AIResolvedClient | null {
    return this.normalizeResolved(model, this.getClientInner(model));
  }

  private normalizeResolved(model: string, r: AIResolvedClient | null): AIResolvedClient | null {
    if (!r) return r;
    const strict = String(process.env.LINGXI_STRICT_MODEL || 'false').toLowerCase() !== 'false';
    if (r.degraded && strict && model && model.trim()) {
      console.error(`[AI Hub][STRICT] 模型 "${model}" 未命中且 LINGXI_STRICT_MODEL=true → 拒绝静默替换，返回 null`);
      return null;
    }
    const shell = /:(cloud|remote)$|-cloud$/i.test(r.resolvedModel);
    if (shell) return { ...r, isLocal: false, viaLocalDaemon: true, realLocal: false };
    return { ...r, realLocal: !!r.isLocal };
  }

  private getClientInner(model: string): AIResolvedClient | null {
      // 确保索引已建立
      if (!this.indexBuilt) this.buildModelIndex();

      // 0. 空模型名兜底
      if (!model) {
        const defaultModel = this.getDefaultModel();
        if (defaultModel) {
          return this.getClient(defaultModel);
        }
        const first = this.providers.values().next().value;
        return first ? { client: first.client, resolvedModel: first.config.models[0] || "" } : null;
      }

      // 1. 精确匹配：直接从索引查找 O(1)
      const exactList = this.modelIndex.get(model);
      if (exactList && exactList.length > 0) {
        // 索引已按非本地优先排序
        const pick = exactList[0];
        // 检查是否为 Ollama 转发壳且需要修正到云端
        const strictCloudSuffix = String(process.env.LINGXI_CLOUD_SUFFIX_STRICT || 'true').toLowerCase() !== 'false';
        if (strictCloudSuffix && /:(cloud|remote)$/i.test(model) && pick.isLocal) {
          const nm = this.normalizeModelName(model);
          const normList = this.modelIndex.get(nm);
          if (normList) {
            const cloudPick = normList.find(x => !x.isLocal);
            if (cloudPick) {
              console.warn(`[AI Hub][MODEL] "${model}" 是 Ollama 转发壳且只命中本地 → 规范化名 "${nm}" 在云 provider ${cloudPick.pid} 存在，改走云端`);
              return { client: cloudPick.entry.client, resolvedModel: nm, providerId: cloudPick.pid, isLocal: false, degraded: false };
            }
          }
        }
        console.warn(`[AI Hub][MODEL] "${model}" 精确命中 ${exactList.length} 个 provider，选中 ${pick.pid} (isLocal=${pick.isLocal})`);
        return { client: pick.entry.client, resolvedModel: model, providerId: pick.pid, isLocal: pick.isLocal, degraded: false };
      }

      // 2. 规范化后精确匹配
      const strippedModel = this.normalizeModelName(model);
      if (strippedModel !== model) {
        const normList = this.modelIndex.get(strippedModel);
        if (normList && normList.length > 0) {
          const pick = normList[0]; // 已按非本地优先排序
          if (pick.isLocal && normList.length > 1) {
            // 尝试找非本地的
            const cloudPick = normList.find(x => !x.isLocal);
            if (cloudPick) {
              return { client: cloudPick.entry.client, resolvedModel: strippedModel, providerId: cloudPick.pid, isLocal: false, degraded: false };
            }
          }
          console.warn(`[AI Hub][MODEL] "${model}" 规范化后 "${strippedModel}" 命中 ${normList.length} 个 provider，选中 ${pick.pid} (isLocal=${pick.isLocal})`);
          return { client: pick.entry.client, resolvedModel: strippedModel, providerId: pick.pid, isLocal: pick.isLocal, degraded: false };
        }
      }

      // 3. provider id 与模型名有共同前缀的优先
      // 需要遍历 providers，但只做前缀检查，不遍历模型数组
      const prefixHits: { pid: string; entry: any; matched: string }[] = [];
      for (const [pid, entry] of this.providers) {
        // 从索引快速检查：这个 provider 是否有包含 model 前缀的模型
        // 这里仍需遍历，但 provider 数量少(~20)，可接受
        const m0 = entry.config.models.find((m: string) => model.includes(m) || m.includes(model));
        if (!m0) continue;
        if (model.toLowerCase().includes(pid.toLowerCase()) || pid.toLowerCase().includes(model.split("-")[0])) {
          prefixHits.push({ pid, entry, matched: m0 });
        }
      }
      if (prefixHits.length > 0) {
        const ordered = prefixHits.filter(h => !h.entry.config.isLocal).concat(prefixHits.filter(h => h.entry.config.isLocal));
        const h = ordered[0];
        return { client: h.entry.client, resolvedModel: h.matched || model, providerId: h.pid, isLocal: !!h.entry.config.isLocal, degraded: false };
      }

      // 4. 模糊匹配兜底：使用索引加速
      // 遍历索引中的所有模型名，找包含关系
      const fuzzyCandidates: { pid: string; entry: any; matchedModel: string; isLocal: boolean }[] = [];
      for (const [indexedModel, list] of this.modelIndex) {
        if (model.includes(indexedModel) || indexedModel.includes(model)) {
          for (const item of list) {
            fuzzyCandidates.push({ pid: item.pid, entry: item.entry, matchedModel: indexedModel, isLocal: item.isLocal });
          }
        }
      }
      if (fuzzyCandidates.length > 0) {
        // 按非本地优先排序
        fuzzyCandidates.sort((a, b) => a.isLocal ? 1 : -1);
        const h = fuzzyCandidates[0];
        return { client: h.entry.client, resolvedModel: h.matchedModel, providerId: h.pid, isLocal: h.isLocal, degraded: false };
      }

      // 5. fallback: 英伟达 → Ollama → 第一个 provider
      for (const [, entry] of this.providers) {
        if (entry.config.type === "nvidia" && entry.config.models.length > 0) {
          const fallbackModel = entry.config.models[0];
          console.error(`[AI Hub][DEGRADED] 模型 "${model}" 未命中任何 provider → 降级到 NVIDIA: ${fallbackModel}。请检查模型名与 *_API_KEY。`);
          return { client: entry.client, resolvedModel: fallbackModel, providerId: 'nvidia-nim', isLocal: false, degraded: true };
        }
      }
      // ★ patch-v20:applied 核心护栏：静默降级到本地 = 速度掉 10~60 倍 + 任务超时，必须显形且可控
      const allowLocalFallback = String(process.env.LINGXI_ALLOW_LOCAL_FALLBACK || 'false').toLowerCase() !== 'false';
      for (const [pid, entry] of this.providers) {
        if (entry.config.isLocal && entry.config.models.length > 0) {
          // 优先选工具能力更好的本地模型，而非盲取 models[0]（可能是无关的转发壳/实验模型）
          // patch-v21:applied：优先选「云端中继壳」（远端推理），避免直接掉进本机 CPU
          const shell = entry.config.models.find((m: string) => /:(cloud|remote)$|-cloud$/i.test(m));
          const fallbackModel = shell || entry.config.models.find((m: string) => /^(llama|qwen)/i.test(m)) || entry.config.models[0];
          const realLocal = !/:(cloud|remote)$|-cloud$/i.test(fallbackModel);
          const detail =
            `[AI Hub][DEGRADED-TO-LOCAL] ✗✗ 模型 "${model}" 未命中任何可用 provider，正降级到本地 (${pid}) 的 "${fallbackModel}"。` +
            `本地推理通常比云端慢 10~60 倍，极易触发 executor 超时（表现为「任务干到一半突然没了」）。` +
            `排查：① DEFAULT_MODEL / TOOL_MODEL / REPLY_MODEL 是否为真实云端模型名 ` +
            `② 对应 *_API_KEY 是否已配置 ③ 模型名是否在 hub 的 provider models 清单内。`;
          if (realLocal && !allowLocalFallback) {
            console.error(detail + ` [${fallbackModel} 属真本机推理且 LINGXI_ALLOW_LOCAL_FALLBACK=false → 拒绝，返回 null]`);
            return null;
          }
          console.error(detail + ` [${realLocal ? '真本机推理' : '云端中继壳'} → 已放行，标记 degraded=true]`);
          return { client: entry.client, resolvedModel: fallbackModel, providerId: pid, isLocal: !!entry.config.isLocal, degraded: true };
        }
      }

      // 6. 最后兜底（patch-v20:applied：该路径同属降级，必须标记）
      const firstEntry: any = this.providers.entries().next().value;
      if (!firstEntry) return null;
      // patch-v21:applied ★ 不谎报：models 未同步时不能把请求名当"已解析"；真本机推理受开关约束
      const firstCfg = firstEntry[1].config;
      const firstModels: string[] = Array.isArray(firstCfg.models) ? firstCfg.models : [];
      const allowLocal2 = String(process.env.LINGXI_ALLOW_LOCAL_FALLBACK || 'false').toLowerCase() !== 'false';
      if (firstModels.length === 0) {
        console.error(
          `[AI Hub][MODEL-UNVERIFIED] 模型 "${model}" 无处可去且 provider ${firstEntry[0]} 型号清单为空` +
          `（可能 Ollama 未同步）→ 仍按 ${model} 发给该 provider，但标记 degraded（未经校验）`
        );
        return { client: firstEntry[1].client, resolvedModel: model, providerId: firstEntry[0], isLocal: !!firstCfg.isLocal, degraded: true };
      }
      const firstFallback = firstModels[0];
      const firstRealLocal = !!firstCfg.isLocal && !/:(cloud|remote)$|-cloud$/i.test(firstFallback);
      console.error(
        `[AI Hub][DEGRADED-TO-LOCAL] 模型 "${model}" 无处可去 → 仅剩 ${firstEntry[0]}/${firstFallback}` +
        ` (真本机推理=${firstRealLocal}, allowLocalFallback=${allowLocal2})`
      );
      if (firstRealLocal && !allowLocal2) {
        console.error('[AI Hub][FATAL] 唯一可用 provider 为真本机推理且开关关闭 → 返回 null（拒绝静默降级）');
        return null;
      }
      return { client: firstEntry[1].client, resolvedModel: firstFallback, providerId: firstEntry[0], isLocal: !!firstCfg.isLocal, degraded: true };
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
      if (this.modelHealth.isUnhealthy(matched)) {
        console.log(`[AI Hub] 故障转移候选 ${pid}/${matched} 健康缓存标记不健康，跳过`);
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
    if (result && (result.resolvedModel !== model || result.degraded || result.isLocal)) {
      // patch-v20:applied：模型归属漂移必须 error 级可见（此前只有一行 warn，前端零感知）
      const tag = result.isLocal ? 'LOCAL!' : result.degraded ? 'DEGRADED' : 'RENAMED';
      console.error(
        `[AIHub][MODEL-DRIFT][${tag}] getRoleClient(${role}): 请求 ${model} → 实际 ${result.resolvedModel}` +
        ` @ ${result.providerId || '?'} (isLocal=${!!result.isLocal}, degraded=${!!result.degraded})`
      );
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
  /**
   * v2.0.46: 主动探测模型健康（1-token 请求 + 短超时），结果写入 modelHealth 缓存。
   * 供路由前预检 / 定期巡检 / 管理诊断使用。模型无法解析到 provider 时返回 null。
   */
  async probeModel(model: string, timeoutMs = 8000): Promise<ProbeResult | null> {
    const resolved = this.getClient(model);
    if (!resolved) return null;
    return probeModelHealth(resolved.client, resolved.resolvedModel, {
      timeoutMs,
      cache: this.modelHealth,
    });
  }
  
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
    // v2.0.46: 健康缓存快速失败 —— 近期探针/超时标记不健康的模型立即报错，
    // 避免对「目录在列但推理无响应」的幽灵模型干等客户端超时（调用方可走备胎接管）
    const healthMark = this.modelHealth.getMark(cbKey);
    if (healthMark) {
      const remainS = Math.ceil((healthMark.until - Date.now()) / 1000);
      throw new Error(`模型不健康: ${cbKey}（${healthMark.reason}），${remainS}s 内自动排除，请改用备用模型或稍后重试`);
    }
    const cbState = this.circuitBreaker.get(cbKey);
    if (cbState && cbState.failures >= this.CB_THRESHOLD) {
      const elapsed = Date.now() - cbState.lastFail;
      if (elapsed < this.CB_COOLDOWN) {
        throw new Error(`熔断器开启: ${resolvedModel} 连续失败 ${cbState.failures} 次，冷却中(${Math.ceil((this.CB_COOLDOWN - elapsed) / 1000)}s)`);
      }
      // 冷却期已过，半开放：允许一次尝试
      cbState.failures = this.CB_THRESHOLD - 1;
    }

    // 统一退避：等待时长由 retry-coordinator 计算（全抖动指数退避 + Retry-After + 服务端 reset 提示解析）
    //   v2.8.0 之前这里是写死的 1000*2^(n-1) / 上限 16s / 无 jitter / 无视 Retry-After，
    //   与 executor 各算各的，同一次 429 在两层被叠乘放大。
    const MAX_RETRIES = parseInt(process.env.AI_HUB_MAX_RETRIES || '3', 10);
    const HUB_BUDGET = { ...DEFAULT_RETRY_BUDGET, tag: 'AIHub', capMs: 16_000 };
    let lastError: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const { delayMs, serverHintMs } = computeDelayMs(lastError, attempt, HUB_BUDGET);
          const hint = serverHintMs ? `（服务端建议 ${Math.round(serverHintMs / 1000)}s）` : '';
          console.log(`[AI Hub] 重试 ${request.model} (${attempt}/${MAX_RETRIES}) — 退避 ${delayMs}ms${hint}`);
          await new Promise(r => setTimeout(r, delayMs));
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
        this.modelHealth.markHealthy(cbKey); // v2.0.46: 成功即恢复健康标记
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
          // v2.0.46: 超时/连接类错误（无 HTTP 状态、纯挂死）首次即标记不健康，
          // TTL 内后续请求与故障转移候选快速排除，不必等熔断器攒满 5 次失败
          if (isTimeoutLikeError(error)) {
            this.modelHealth.markUnhealthy(cbKey, String(error?.message || error));
          }
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
        // 402 余额不足：对同一 provider 重试毫无意义，跳过指数退避立即故障转移。
        // 2026-11-11 起 402 同时进 FATAL_STATUSES 与 BLACKLIST_STATUSES（见上方常量），
        // 上面 FATAL_STATUSES 分支会先抛出并记录黑名单，这里只作为兜底（当 provider 有备胎时仍可救回）。
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