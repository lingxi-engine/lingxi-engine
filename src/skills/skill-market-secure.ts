/**
 * 安全技能市场客户端 — 带 Ed25519 签名校验的市场浏览/安装
 *
 * 相对 skill-manager.ts 的 browseMarket/installFromMarket：
 * - 安装包改为 manifest.json + 文件列表 + 签名 的结构
 * - 安装前完整走 verifySkillPackage（签名 + sha256 + 路径穿越）
 * - 市场地址可配置（SKILL_MARKET_URL），默认 agentskills.io
 * - 安装落盘前写入临时目录再原子重命名，避免半包入库
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_MARKET_URL,
  verifySkillPackage,
  isSafeRelativePath,
  isSafeSkillName,
  type SkillManifest,
} from '../security/skill-sign.js';

export interface SecureMarketItem {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  url: string;
  verified: boolean; // 市场返回的 verified 标记
  installed: boolean;
}

export interface InstallResult {
  ok: boolean;
  errors: string[];
  skillId?: string;
}

function marketBase(): string {
  return (process.env.SKILL_MARKET_URL || DEFAULT_MARKET_URL).replace(/\/+$/, '');
}

export class SecureSkillMarket {
  constructor(
    private skillsDir: string,
    private isInstalled: (name: string) => boolean = () => false,
  ) {}

  /** 浏览市场技能列表 */
  async browse(): Promise<SecureMarketItem[]> {
    try {
      const res = await fetch(`${marketBase()}/api/skills`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any[];
      return data.map(item => ({
        name: item.name,
        description: item.description || '',
        author: item.metadata?.author,
        version: item.metadata?.version,
        license: item.license,
        url: item.url || item.repo || `${marketBase()}/skills/${item.name}`,
        verified: !!item.verified,
        installed: this.isInstalled(item.name),
      }));
    } catch (err: any) {
      console.error('[SkillMarket] 浏览失败:', err.message);
      return [];
    }
  }

  /**
   * 安全安装：下载包 -> 校验签名+hash -> 原子落盘
   * 包格式约定（zip 解开后）：manifest.json + 其 files 清单列出的文件
   * 这里用 JSON 形式传输：GET /api/skills/:name/package 返回
   * { manifest: string, files: { [path]: base64 } }
   */
  async install(skillName: string): Promise<InstallResult> {
    const errors: string[] = [];
    try {
      const res = await fetch(`${marketBase()}/api/skills/${encodeURIComponent(skillName)}/package`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return { ok: false, errors: [`下载失败 HTTP ${res.status}`] };
      const pkg = (await res.json()) as { manifest: string; files: Record<string, string> };

      // base64 -> Buffer
      const files = new Map<string, Buffer>();
      for (const [p, b64] of Object.entries(pkg.files || {})) {
        if (!isSafeRelativePath(p)) {
          return { ok: false, errors: [`非法文件路径: ${p}`] };
        }
        files.set(p, Buffer.from(b64, 'base64'));
      }

      const verdict = verifySkillPackage(files, pkg.manifest);
      errors.push(...verdict.errors);
      if (!verdict.ok || !verdict.manifest) {
        return { ok: false, errors };
      }
      const manifest: SkillManifest = verdict.manifest;
      const skillId = manifest.name;
      // 双保险：落盘前再校验技能名（防路径穿越写任意目录）
      if (!isSafeSkillName(skillId)) {
        return { ok: false, errors: [`非法技能名: ${skillId}`] };
      }

      // 临时目录写入 -> 原子重命名
      const tmp = join(tmpdir(), `lingxi-skill-${skillId}-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      try {
        for (const [p, buf] of files) {
          const dest = join(tmp, p);
          mkdirSync(resolve(dest, '..'), { recursive: true });
          writeFileSync(dest, buf);
        }
        const finalDir = join(this.skillsDir, skillId);
        if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
        renameSync(tmp, finalDir);
        console.log(`[SkillMarket] 已安全安装: ${skillId}@${manifest.version}`);
        return { ok: true, errors, skillId };
      } catch (e: any) {
        rmSync(tmp, { recursive: true, force: true });
        return { ok: false, errors: [`落盘失败: ${e.message}`] };
      }
    } catch (err: any) {
      return { ok: false, errors: [err.message] };
    }
  }

  /** 读取本地已安装技能的 SKILL.md（供校验后加载） */
  readInstalledSkillMd(skillId: string): string | null {
    const p = join(this.skillsDir, skillId, 'SKILL.md');
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  }
}
