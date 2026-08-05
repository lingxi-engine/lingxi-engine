/**
 * Provider 增强管理器
 * 支持任意 OpenAI 兼容端点：llama.cpp, vLLM, LM Studio, text-generation-webui 等
 * 用户在 Web UI 填入 baseURL + apiKey 即可接入
 */

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  models?: string[];      // 手动指定模型列表
  autoDetect?: boolean;   // 自动检测可用模型
}

export interface DetectedModel {
  id: string;
  provider: string;
  size?: string;
  contextLength?: number;
}

export class CustomProviderManager {
  private providers: Map<string, CustomProviderConfig> = new Map();

  /**
   * 添加自定义 Provider
   */
  add(config: CustomProviderConfig): void {
    this.providers.set(config.id, config);
    console.log(`[CustomProvider] 添加: ${config.name} (${config.baseURL})`);
  }

  /**
   * 删除
   */
  remove(id: string): boolean {
    return this.providers.delete(id);
  }

  /**
   * 列出所有
   */
  list(): CustomProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * 获取
   */
  get(id: string): CustomProviderConfig | undefined {
    return this.providers.get(id);
  }

  /**
   * 检测可用模型（调用 /v1/models 端点）
   */
  async detectModels(baseURL: string, apiKey?: string): Promise<DetectedModel[]> {
    const headers: Record<string, string> = {};
    if (apiKey && apiKey !== 'local' && apiKey !== 'dummy') headers['Authorization'] = `Bearer ${apiKey}`;
    
    // 策略1: Ollama 原生 /api/tags（最可靠）
    if (baseURL.includes(':11434') || baseURL.includes('/ollama')) {
      try {
        const tagUrl = baseURL.replace(/\/v1\/?$/, '') + '/api/tags';
        const res = await fetch(tagUrl, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json() as any;
          const list = data.models || [];
          return list.map((m: any) => ({
            id: m.name || m.model || m.id,
            provider: baseURL,
            contextLength: m.details?.parameter_size ? undefined : m.context_length,
          }));
        }
      } catch (e: any) {
        console.error('[CustomProvider] Ollama /api/tags 失败:', e.message);
      }
    }
    
    // 策略2: OpenAI 兼容 /v1/models
    try {
      const res = await fetch(`${baseURL}/models`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      
      if (res.ok) {
        const data = await res.json() as any;
        const models: DetectedModel[] = [];
        // 兼容 data: null（Ollama 空模型时返回 null）
        const list = data.data || data.models || [];
        if (Array.isArray(list)) {
          for (const m of list) {
            models.push({
              id: m.id || m.name || m.model,
              provider: baseURL,
              contextLength: m.context_length,
            });
          }
        }
        return models;
      }
    } catch (e: any) {
      console.error(`[CustomProvider] /v1/models 失败 (${baseURL}):`, e.message);
    }
    
    // 策略3: 通用 /api/tags fallback（部分兼容端点）
    try {
      const tagUrl = baseURL.replace(/\/v1\/?$/, '') + '/api/tags';
      const res = await fetch(tagUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as any;
        const list = data.models || [];
        if (Array.isArray(list) && list.length > 0) {
          return list.map((m: any) => ({
            id: m.name || m.model || m.id,
            provider: baseURL,
          }));
        }
      }
    } catch {}
    
    return [];
  }

  /**
   * 测试连接
   */
  async testConnection(config: CustomProviderConfig): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      const models = await this.detectModels(config.baseURL, config.apiKey);
      // 有模型就返回，没有模型也返回 ok=true（表示连接成功，只是没装模型）
      if (models.length > 0) {
        return { ok: true, models: models.map(m => m.id) };
      }
      // 没有模型但连接是通的 — 返回 ok=true，空 models
      // 再试一下 version 端点确认服务活着
      try {
        const versionUrl = config.baseURL.replace(/\/v1\/?$/, '') + '/api/version';
        const vRes = await fetch(versionUrl, { signal: AbortSignal.timeout(5000) });
        if (vRes.ok) return { ok: true, models: [] };
      } catch {}
      // 试 /v1/models 端点是否活着（返回非 4xx 就算连接成功）
      const headers: Record<string, string> = {};
      if (config.apiKey && config.apiKey !== 'local') headers['Authorization'] = `Bearer ${config.apiKey}`;
      const res = await fetch(`${config.baseURL}/models`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return { ok: true, models: [] };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 获取 OpenAI 客户端配置
   */
  getClientConfig(id: string): { baseURL: string; apiKey: string } | null {
    const p = this.providers.get(id);
    if (!p) return null;
    return { baseURL: p.baseURL, apiKey: p.apiKey || 'dummy' };
  }
}

// ── 常见推理后端默认配置 ──

export const INFERENCE_BACKENDS = [
  {
    id: 'ollama',
    name: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    description: '本地运行，自动模型管理，推荐',
    apiKey: 'ollama',
    docs: 'https://ollama.ai',
  },
  {
    id: 'llama-cpp',
    name: 'llama.cpp',
    baseURL: 'http://localhost:8080/v1',
    description: 'C++ 推理，OpenAI 兼容 API 模式',
    apiKey: 'dummy',
    docs: 'https://github.com/ggerganov/llama.cpp',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    baseURL: 'http://localhost:8000/v1',
    description: '高吞吐量推理，OpenAI 兼容 API',
    apiKey: 'dummy',
    docs: 'https://github.com/vllm-project/vllm',
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    baseURL: 'http://localhost:1234/v1',
    description: '桌面端本地推理，图形界面',
    apiKey: 'lm-studio',
    docs: 'https://lmstudio.ai',
  },
  {
    id: 'text-gen-webui',
    name: 'Text Generation WebUI',
    baseURL: 'http://localhost:5000/v1',
    description: 'Oobabooga Text Generation WebUI',
    apiKey: 'dummy',
    docs: 'https://github.com/oobabooga/text-generation-webui',
  },
  {
    id: 'tgi',
    name: 'TGI (Text Generation Inference)',
    baseURL: 'http://localhost:8080/v1',
    description: 'HuggingFace TGI，OpenAI 兼容',
    apiKey: 'dummy',
    docs: 'https://github.com/huggingface/text-generation-inference',
  },
  {
    id: 'custom',
    name: '自定义端点',
    baseURL: '',
    description: '任意 OpenAI 兼容 API 端点',
    apiKey: '',
    docs: '',
  },
];
