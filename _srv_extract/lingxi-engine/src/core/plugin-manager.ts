/**
 * 插件系统 - Plugin System
 * 
 * 灵犀引擎的扩展机制：
 *   - 每个插件是一个目录，包含 plugin.json + 代码
 *   - 插件可以注册：工具、技能、渠道、Provider
 *   - 通过 API 动态加载/卸载
 * 
 * 灵感来源：Hermes 的插件机制
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import type { ToolDefinition } from "../tools/types.js";

// ── 插件描述 ──

export interface PluginManifest {
  /** 插件 ID（唯一） */
  id: string;
  /** 显示名 */
  name: string;
  /** 版本 */
  version: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 插件类型 */
  type: 'tool' | 'channel' | 'provider' | 'skill' | 'hybrid';
  /** 入口文件（相对插件目录） */
  main: string;
  /** 依赖的 npm 包 */
  dependencies?: string[];
  /** 提供的工具列表 */
  tools?: ToolDefinition[];
  /** 提供的技能 ID */
  skills?: string[];
  /** 需要的配置项 */
  config?: Record<string, PluginConfigField>;
  /** 是否启用 */
  enabled?: boolean;
}

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  description: string;
  default?: any;
  required?: boolean;
  envKey?: string;  // 从环境变量读取的 key
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
  module: any | null;      // 加载后的模块
  toolHandlers?: Record<string, (args: Record<string, any>) => Promise<any>>;
  initialized: boolean;
}

// ── 插件管理器 ──

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private pluginDirs: string[] = [];

  constructor(pluginDirs?: string[]) {
    // 默认搜索路径
    this.pluginDirs = pluginDirs || [
      join(process.cwd(), 'plugins'),
      join(process.cwd(), 'node_modules', 'lingxi-plugin-*'),
    ];
  }

  /**
   * 扫描并加载所有插件
   */
  async loadAll(): Promise<{ loaded: number; failed: number; skipped: number }> {
    let loaded = 0, failed = 0, skipped = 0;

    for (const dir of this.pluginDirs) {
      if (!existsSync(dir)) continue;

      // 处理通配符目录
      if (dir.includes('*')) {
        const parentDir = dir.split('*')[0].replace(/[/\\]$/, '');
        if (!existsSync(parentDir)) continue;
        const entries = readdirSync(parentDir);
        for (const entry of entries) {
          const fullDir = join(parentDir, entry);
          if (statSync(fullDir).isDirectory() && entry.startsWith('lingxi-plugin-')) {
            const result = await this.loadPlugin(fullDir);
            if (result === 'loaded') loaded++;
            else if (result === 'failed') failed++;
            else skipped++;
          }
        }
      } else {
        // 普通目录：遍历子目录
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullDir = join(dir, entry);
          if (statSync(fullDir).isDirectory()) {
            const result = await this.loadPlugin(fullDir);
            if (result === 'loaded') loaded++;
            else if (result === 'failed') failed++;
            else skipped++;
          }
        }
      }
    }

    console.log(`[Plugins] 加载完成: ${loaded} 成功, ${failed} 失败, ${skipped} 跳过`);
    return { loaded, failed, skipped };
  }

  /**
   * 加载单个插件
   */
  async loadPlugin(dir: string): Promise<'loaded' | 'failed' | 'skipped'> {
    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) return 'skipped';

    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const manifest: PluginManifest = JSON.parse(raw);

      if (this.plugins.has(manifest.id)) {
        console.log(`[Plugins] ${manifest.id} 已加载，跳过`);
        return 'skipped';
      }

      if (manifest.enabled === false) {
        console.log(`[Plugins] ${manifest.id} 已禁用`);
        return 'skipped';
      }

      // 检查环境变量依赖
      if (manifest.config) {
        for (const [key, field] of Object.entries(manifest.config)) {
          if (field.required && field.envKey) {
            const val = process.env[field.envKey];
            if (!val) {
              console.log(`[Plugins] ${manifest.id} 缺少必要配置: ${field.envKey}`);
              return 'skipped';
            }
          }
        }
      }

      // 加载模块
      let module = null;
      let toolHandlers: Record<string, (args: Record<string, any>) => Promise<any>> = {};
      const mainPath = resolve(dir, manifest.main);
      if (existsSync(mainPath)) {
        try {
          module = await import(pathToFileURL(mainPath).href);
          if (module.default?.getToolHandlers) {
            toolHandlers = module.default.getToolHandlers();
          }
        } catch (err: any) {
          console.error(`[Plugins] ${manifest.id} 模块加载失败:`, err.message);
        }
      }

      const loaded: LoadedPlugin = {
        manifest,
        dir,
        enabled: true,
        module,
        toolHandlers,
        initialized: false,
      };

      this.plugins.set(manifest.id, loaded);
      console.log(`[Plugins] ✅ ${manifest.id} v${manifest.version}: ${manifest.description}`);
      return 'loaded';
    } catch (err: any) {
      console.error(`[Plugins] 加载失败 ${dir}:`, err.message);
      return 'failed';
    }
  }

  /**
   * 卸载插件
   */
  unloadPlugin(id: string): boolean {
    return this.plugins.delete(id);
  }

  /**
   * 启用/禁用插件
   */
  setEnabled(id: string, enabled: boolean): void {
    const plugin = this.plugins.get(id);
    if (plugin) plugin.enabled = enabled;
  }

  /**
   * 获取插件提供的所有工具定义
   */
  getAllToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled) continue;
      if (plugin.manifest.tools) {
        tools.push(...plugin.manifest.tools);
      }
    }
    return tools;
  }

  /**
   * 调用插件工具
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.toolHandlers) continue;
      if (plugin.toolHandlers[toolName]) {
        return await plugin.toolHandlers[toolName](args);
      }
    }
    throw new Error(`插件工具 "${toolName}" 未找到`);
  }

  /**
   * 检查是否拥有某工具
   */
  hasTool(toolName: string): boolean {
    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled || !plugin.toolHandlers) continue;
      if (plugin.toolHandlers[toolName]) return true;
    }
    return false;
  }

  /**
   * 获取插件提供的技能 ID
   */
  getAllSkills(): string[] {
    const skills: string[] = [];
    for (const [, plugin] of this.plugins) {
      if (!plugin.enabled) continue;
      if (plugin.manifest.skills) skills.push(...plugin.manifest.skills);
    }
    return skills;
  }

  /**
   * 列出所有插件
   */
  listPlugins(): { id: string; name: string; version: string; type: string; enabled: boolean; toolCount: number }[] {
    const result: any[] = [];
    for (const [, plugin] of this.plugins) {
      result.push({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        type: plugin.manifest.type,
        enabled: plugin.enabled,
        toolCount: plugin.manifest.tools?.length || 0,
      });
    }
    return result;
  }

  /**
   * 获取插件数
   */
  get size() { return this.plugins.size; }
}
