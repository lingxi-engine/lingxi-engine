/**
 * 灵犀引擎 - 本地小模型推理接口
 * 
 * 通过 llama.cpp 的 N-API binding 调用本地模型（可选功能）。
 * 移动端默认使用云端 API，本地模型作为离线降级方案。
 * 
 * 支持的模型：Qwen2.5-1.5B-Instruct, Phi-3-mini 等 (GGUF 格式)
 * 模型文件存放：LINGXI_DATA_DIR/models/*.gguf
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

// ═══ 类型定义 ═══
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalModelInfo {
  available: boolean;
  modelPath: string | null;
  modelName: string | null;
  sizeBytes: number;
  backend: 'llama-cpp' | 'none';
}

// ═══ 状态 ═══
let _modelLoaded = false;
let _modelPath: string | null = null;
let _llamaBinding: any = null;

// 模型搜索路径
const MODEL_DIRS = [
  process.env.LINGXI_MODEL_DIR || '',
  join(process.env.LINGXI_DATA_DIR || join(process.cwd(), 'data'), 'models'),
  join(process.cwd(), 'models'),
].filter(Boolean);

// ═══ 初始化 ═══
function tryLoadBinding(): boolean {
  if (_llamaBinding !== null) return _llamaBinding !== false;
  try {
    // 尝试加载 llama.cpp 的 N-API binding
    // 这个 binding 需要针对目标平台（Android/iOS）编译
    _llamaBinding = require('llama-cpp-node');
    return true;
  } catch {
    // binding 不存在（大多数情况），使用云端 API
    _llamaBinding = false;
    return false;
  }
}

function findModel(): string | null {
  for (const dir of MODEL_DIRS) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      const gguf = files.find(f => f.endsWith('.gguf'));
      if (gguf) return join(dir, gguf);
    } catch { /* skip */ }
  }
  return null;
}

// ═══ 公开 API ═══

/**
 * 检查本地模型是否可用
 */
export function isLocalModelAvailable(): boolean {
  if (!tryLoadBinding()) return false;
  if (_modelPath) return true;
  _modelPath = findModel();
  return _modelPath !== null;
}

/**
 * 获取本地模型信息
 */
export function getLocalModelInfo(): LocalModelInfo {
  const available = isLocalModelAvailable();
  let sizeBytes = 0;
  let modelName: string | null = null;

  if (_modelPath && existsSync(_modelPath)) {
    try {
      const { statSync } = require('fs');
      sizeBytes = statSync(_modelPath).size;
      modelName = _modelPath.split(/[/\\]/).pop()?.replace('.gguf', '') || null;
    } catch { /* ignore */ }
  }

  return {
    available,
    modelPath: _modelPath,
    modelName,
    sizeBytes,
    backend: available ? 'llama-cpp' : 'none',
  };
}

/**
 * 使用本地模型进行对话
 * @param messages 对话消息数组
 * @returns 生成的回复文本
 */
export async function localChat(messages: ChatMessage[]): Promise<string> {
  if (!isLocalModelAvailable()) {
    throw new Error('本地模型不可用，请使用云端 API');
  }

  if (!_modelLoaded && _modelPath) {
    try {
      await _llamaBinding.loadModel(_modelPath, {
        n_ctx: 2048,
        n_threads: 4,
        use_mmap: true,
      });
      _modelLoaded = true;
      console.log('[LocalLLM] 模型已加载:', _modelPath);
    } catch (err: any) {
      throw new Error('模型加载失败: ' + err.message);
    }
  }

  try {
    // 构建 prompt
    const prompt = messages.map(m => {
      if (m.role === 'system') return `<|system|>\n${m.content}`;
      if (m.role === 'user') return `<|user|>\n${m.content}`;
      return `<|assistant|>\n${m.content}`;
    }).join('\n') + '\n<|assistant|>\n';

    const result = await _llamaBinding.generate(prompt, {
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      stop: ['<|user|>', '<|system|>', '<|endoftext|>'],
    });

    return result.text?.trim() || '';
  } catch (err: any) {
    throw new Error('本地推理失败: ' + err.message);
  }
}

/**
 * 卸载模型释放内存
 */
export async function unloadModel(): Promise<void> {
  if (_modelLoaded && _llamaBinding) {
    try {
      await _llamaBinding.unloadModel();
      _modelLoaded = false;
      console.log('[LocalLLM] 模型已卸载');
    } catch { /* ignore */ }
  }
}
