/**
 * Provider 注册表 - 多 AI 提供商动态管理
 * 支持运行时添加/删除/切换 Provider
 * 
 * 已内置：NVIDIA NIM / OpenAI / Ollama
 * 可扩展：Anthropic / Google / DeepSeek / vLLM / Ollama-cloud / 自定义
 */

import OpenAI from "openai";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { dataDir, dataPath } from '../core/paths.js';

const PROVIDERS_STORE_PATH = dataPath('providers.json');

interface PersistedProvider {
  id: string; type: string; name: string; apiKey?: string;
  baseUrl: string; models: string[]; isLocal: boolean; enabled: boolean;
}

export interface ProviderEntry {
  id: string;
  type: string;
  name: string;
  apiKey?: string;
  baseUrl: string;
  models: string[];
  isLocal: boolean;
  enabled: boolean;
  client: OpenAI;
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderEntry>();
  // 反向索引：模型名 -> provider 条目数组（按优先级排序：非本地优先）
  private modelIndex: Map<string, { providerId: string; entry: ProviderEntry; isLocal: boolean }[]> = new Map();
  private indexBuilt = false;

  /** 从磁盘恢复已保存的 Provider（异步读取） */
    restore(): Promise<number> {
      return (async () => {
        try {
          const { readFile } = await import('fs/promises');
          const { existsSync } = await import('fs');
          if (!existsSync(PROVIDERS_STORE_PATH)) return 0;
          const raw = await readFile(PROVIDERS_STORE_PATH, 'utf8');
          const entries: PersistedProvider[] = JSON.parse(raw);
          for (const e of entries) {
            // 持久化的条目覆盖 env 注册的（用户在前端修改的 API Key 优先）
            if (this.providers.has(e.id)) {
              // 用持久化的 apiKey 覆盖 env 注册的
              const old = this.providers.get(e.id)!;
              old.apiKey = e.apiKey || old.apiKey;
              old.baseUrl = e.baseUrl || old.baseUrl;
              old.models = e.models && e.models.length ? e.models : old.models;
              old.name = e.name || old.name;
              old.enabled = e.enabled !== undefined ? e.enabled : old.enabled;
              // 重建 client（apiKey 可能变了）
              old.client = new OpenAI({ apiKey: e.apiKey || 'dummy', baseURL: old.baseUrl });
              continue;
            }
            const client = new OpenAI({ apiKey: e.apiKey || 'dummy', baseURL: e.baseUrl });
            this.providers.set(e.id, { ...e, client });
          }
          console.log(`[ProviderRegistry] 从磁盘恢复 ${entries.length} 个 Provider`);
          this.buildModelIndex();
          this.persist(); // 合并 env + 用户覆盖后统一存盘
          return entries.length;
        } catch (e) { console.warn('[ProviderRegistry] 恢复失败:', (e as Error).message); return 0; }
      })();
    }

    /** 建立/重建模型名 -> provider 反向索引 */
    private buildModelIndex(): void {
      this.modelIndex.clear();
      for (const [providerId, entry] of this.providers) {
        if (!entry.enabled || !entry.models) continue;
        const isLocal = entry.isLocal;
        for (const model of entry.models) {
          if (!model) continue;
          const list = this.modelIndex.get(model) || [];
          list.push({ providerId, entry, isLocal });
          this.modelIndex.set(model, list);
        }
      }
      for (const [model, list] of this.modelIndex) {
        list.sort((a, b) => a.isLocal ? 1 : -1);
      }
      this.indexBuilt = true;
    }

    /** 增量更新索引 */
    private updateModelIndex(providerId: string, entry: ProviderEntry): void {
      if (!entry.enabled || !entry.models) return;
      const isLocal = entry.isLocal;
      for (const model of entry.models) {
        if (!model) continue;
        const list = this.modelIndex.get(model) || [];
        const filtered = list.filter(x => x.providerId !== providerId);
        filtered.push({ providerId, entry, isLocal });
        filtered.sort((a, b) => a.isLocal ? 1 : -1);
        this.modelIndex.set(model, filtered);
      }
    }

    private removeFromModelIndex(providerId: string): void {
      for (const [model, list] of this.modelIndex) {
        const filtered = list.filter(x => x.providerId !== providerId);
        if (filtered.length === 0) {
          this.modelIndex.delete(model);
        } else {
          this.modelIndex.set(model, filtered);
        }
      }
    }

  /** 保存所有 Provider 到磁盘（异步，不阻塞） */
  private persist(): void {
    (async () => {
      try {
        const { writeFile, mkdir } = await import('fs/promises');
        const { dataDir } = await import('../core/paths.js');
        const _dd = dataDir();
        await mkdir(_dd, { recursive: true });
        const entries: PersistedProvider[] = [];
        for (const [, p] of this.providers) {
          entries.push({ id: p.id, type: p.type, name: p.name, apiKey: p.apiKey, baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal, enabled: p.enabled });
        }
        await writeFile(PROVIDERS_STORE_PATH, JSON.stringify(entries, null, 2), 'utf8');
      } catch (e) { console.warn('[ProviderRegistry] 保存失败:', (e as Error).message); }
    })();
  }

  /**
   * 注册一个 Provider
   */
  register(entry: {
    id: string;
    type: string;
    name: string;
    apiKey?: string;
    baseUrl: string;
    models: string[];
    isLocal: boolean;
    enabled?: boolean;
  }, options?: { skipPersist?: boolean }): void {
    if (this.providers.has(entry.id)) {
      throw new Error(`Provider "${entry.id}" 已注册`);
    }
    const client = new OpenAI({
      apiKey: entry.apiKey || 'dummy',
      baseURL: entry.baseUrl,
    });
    const newEntry = {
      ...entry,
      enabled: entry.enabled ?? true,
      client,
    };
    this.providers.set(entry.id, newEntry);
    // 增量更新索引
    this.updateModelIndex(entry.id, newEntry);
    if (!options?.skipPersist) this.persist();  // env 注册阶段跳过，restore 后再统一存
    console.log(`[ProviderRegistry] 注册: ${entry.id} (${entry.name}), ${entry.models.length} 个模型`);
  }

  /**
   * 移除一个 Provider
   */
  unregister(id: string): boolean {
    const ok = this.providers.delete(id);
    if (ok) {
      this.removeFromModelIndex(id);
      this.persist();  // 自动存盘
    }
    return ok;
  }

  /**
   * 启用/禁用 Provider
   */
  setEnabled(id: string, enabled: boolean): void {
    const entry = this.providers.get(id);
    if (entry) {
      entry.enabled = enabled;
      if (enabled) {
        this.updateModelIndex(id, entry);
      } else {
        this.removeFromModelIndex(id);
      }
      this.persist();
    }
  }

  /**
   * 获取一个 Provider
   */
  get(id: string): ProviderEntry | undefined {
    return this.providers.get(id);
  }

  /**
   * 列出所有 Provider
   */
  list(): ProviderEntry[] {
    return Array.from(this.providers.values());
  }

  /**
   * 列出所有可用模型（跨 Provider）
   */
  listModels(): { id: string; provider: string; providerName: string; isLocal: boolean }[] {
    const result: { id: string; provider: string; providerName: string; isLocal: boolean }[] = [];
    for (const [, entry] of this.providers) {
      if (!entry.enabled || !entry.models) continue;
      for (const model of entry.models) {
        result.push({ id: model, provider: entry.id, providerName: entry.name, isLocal: entry.isLocal });
      }
    }
    return result;
  }

  /**
   * 查找模型对应的客户端
   * 优先精确匹配 → 模糊匹配 → fallback
   */
  getClient(model: string): { client: OpenAI; resolvedModel: string; providerId: string } | null {
    // 确保索引已建立
    if (!this.indexBuilt) this.buildModelIndex();

    // 1. 精确匹配：直接从索引查找 O(1)
    const exactList = this.modelIndex.get(model);
    if (exactList && exactList.length > 0) {
      // 索引已按非本地优先排序
      const pick = exactList[0];
      return { client: pick.entry.client, resolvedModel: model, providerId: pick.providerId };
    }

    // 2. 模糊匹配：遍历索引中的所有模型名
    for (const [indexedModel, list] of this.modelIndex) {
      if (model.includes(indexedModel) || indexedModel.includes(model)) {
        const pick = list[0]; // 已按非本地优先排序
        return { client: pick.entry.client, resolvedModel: indexedModel, providerId: pick.providerId };
      }
    }

    // 3. fallback：第一个有模型的启用的 provider
    for (const [providerId, entry] of this.providers) {
      if (!entry.enabled || !entry.models || entry.models.length === 0) continue;
      return { client: entry.client, resolvedModel: entry.models[0], providerId };
    }

    return null;
  }

  /**
   * 添加模型到已有 Provider
   */
  addModel(providerId: string, model: string): void {
    const entry = this.providers.get(providerId);
    if (entry && entry.models && !entry.models.includes(model)) {
      entry.models.push(model);
      // 增量更新索引
      this.updateModelIndex(providerId, entry);
      this.persist();
    }
  }

  /**
   * 从 Provider 中移除指定模型
   */
  removeModel(providerId: string, model: string): boolean {
    const entry = this.providers.get(providerId);
    if (!entry || !entry.models) return false;
    const idx = entry.models.indexOf(model);
    if (idx === -1) return false;
    entry.models.splice(idx, 1);
    // 增量更新索引
    this.updateModelIndex(providerId, entry);
    this.persist();
    console.log(`[ProviderRegistry] 移除模型: ${providerId}/${model}`);
    return true;
  }

  /**
   * 批量注册常用 Provider（从环境变量读取）
   */
  registerFromEnv(): void {
    const sp = { skipPersist: true }; // env 注册阶段不写盘，等 restore() 合并后再统一 persist
    // ── NVIDIA NIM ──
    if (process.env.NVIDIA_API_KEY) {
      this.register({
        id: 'nvidia-nim',
        type: 'nvidia',
        name: 'NVIDIA NIM',
        apiKey: process.env.NVIDIA_API_KEY,
        baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
        models: [
          // 2026-09-13 全量实测 HTTP 200 复核（旧列表多个模型已 410 EOL / 404 无授权）
          'nvidia/nemotron-3-ultra-550b-a55b',
          'nvidia/nemotron-3-super-120b-a12b',
          'nvidia/nemotron-3.5-lightning-30b-a3b',
          'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
          'z-ai/glm-5.3-flash',
          'openai/gpt-oss-20b',
          'deepseek-ai/deepseek-v4-flash-0731',
        ],
        isLocal: false,
        enabled: true,
      }, sp);
    }

    // ── OpenAI ──
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('sk-')) {
      this.register({
        id: 'openai',
        type: 'openai',
        name: 'OpenAI',
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3-mini'],
        isLocal: false,
        enabled: true,
      }, sp);
    }

    // ── Anthropic ──
    if (process.env.ANTHROPIC_API_KEY) {
      this.register({
        id: 'anthropic',
        type: 'anthropic',
        name: 'Anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseUrl: 'https://api.anthropic.com/v1', // 注：Anthropic API 非 OpenAI 兼容，需要适配层
        models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
        isLocal: false,
        enabled: true,
      }, sp);
    }

    // ── Google Gemini ──
    if (process.env.GOOGLE_API_KEY) {
      this.register({
        id: 'google',
        type: 'google',
        name: 'Google Gemini',
        apiKey: process.env.GOOGLE_API_KEY,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        isLocal: false,
        enabled: true,
      }, sp);
    }

    // ── DeepSeek ──
    if (process.env.DEEPSEEK_API_KEY) {
      this.register({
        id: 'deepseek',
        type: 'deepseek',
        name: 'DeepSeek',
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
        isLocal: false,
        enabled: true,
      }, sp);
    }

    // ── OpenRouter (多模型聚合) ──
    if (process.env.OPENROUTER_API_KEY) {
      this.register({
        id: 'openrouter',
        type: 'openrouter',
        name: 'OpenRouter',
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: 'https://openrouter.ai/api/v1',
        // ⚠️ claude-sonnet-4 / gemini-2.5-flash 在本地区返回 403（区域封锁），已移除
        models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3.5-lightning:free', 'minimax/minimax-m3', 'liquid/lfm-2.5-2.6b:free', 'meta-llama/llama-3.3-70b-instruct'],
        isLocal: false,
        enabled: true,
      }, sp);
    }

    // ── vLLM / 自定义 OpenAI 兼容 ──
    if (process.env.VLLM_BASE_URL) {
      this.register({
        id: 'vllm',
        type: 'custom',
        name: 'vLLM / 自定义',
        apiKey: process.env.VLLM_API_KEY || 'dummy',
        baseUrl: process.env.VLLM_BASE_URL,
        models: process.env.VLLM_MODELS?.split(',').map(s => s.trim()) || ['default'],
        isLocal: true,
        enabled: true,
      }, sp);
    }

    // ── Ollama ──
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
    // Ollama 模型列表在启动时动态拉取
    this.register({
      id: 'local-ollama',
      type: 'ollama',
      name: 'Ollama (本地)',
      baseUrl: ollamaUrl,
      models: [], // 动态填充
      isLocal: true,
      enabled: true,
    }, sp);
  }

  /**
   * 获取默认模型
   */
  getDefaultModel(): string {
    if (process.env.DEFAULT_MODEL) return process.env.DEFAULT_MODEL;
    // 优先 nvidia → ollama → 其他
    for (const id of ['nvidia-nim', 'local-ollama']) {
      const entry = this.providers.get(id);
      if (entry?.enabled && entry.models.length > 0) return entry.models[0];
    }
    for (const [, entry] of this.providers) {
      if (entry.enabled && entry.models.length > 0) return entry.models[0];
    }
    return '';
  }
}