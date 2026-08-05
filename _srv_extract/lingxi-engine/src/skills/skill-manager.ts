/**
 * 技能管理器 - Skill Manager
 * 支持 SKILL.md 开放标准（agentskills.io）
 * 
 * 功能：
 * - 加载本地 skills/ 目录下的 SKILL.md
 * - 从 agentskills.io 浏览和安装技能
 * - 技能的启用/禁用/删除
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';

export interface Skill {
  id: string;            // 目录名
  name: string;          // frontmatter name
  description: string;   // frontmatter description
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  content: string;       // Markdown 正文
  path: string;          // 技能目录路径
  installed: boolean;    // 是否已安装
  enabled: boolean;
  source: 'builtin' | 'local' | 'market';
}

export interface SkillMarketItem {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  url: string;
  installed: boolean;
}

export class SkillManager {
  private skillsDir: string;
  private skills: Map<string, Skill> = new Map();
  private enabledSkills: Set<string> = new Set();
  private stateFile: string;

  constructor(skillsDir: string, dataDir: string) {
    this.skillsDir = skillsDir;
    this.stateFile = join(dataDir, 'skills-state.json');
    if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
    this.loadState();
  }

  /**
   * 扫描本地技能目录
   */
  scanLocal(): Skill[] {
    this.skills.clear();
    
    if (!existsSync(this.skillsDir)) return [];
    
    const entries = readdirSync(this.skillsDir);
    for (const entry of entries) {
      const skillPath = join(this.skillsDir, entry);
      if (!statSync(skillPath).isDirectory()) continue;
      
      const skillMdPath = join(skillPath, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;
      
      const skill = this.parseSkillMd(skillMdPath, entry, 'local');
      if (skill) {
        skill.installed = true;
        skill.enabled = this.enabledSkills.has(skill.id);
        this.skills.set(skill.id, skill);
      }
    }
    
    return this.list();
  }

  /**
   * 解析 SKILL.md 文件
   */
  private parseSkillMd(filePath: string, dirName: string, source: 'builtin' | 'local' | 'market'): Skill | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { frontmatter, content } = this.parseFrontmatter(raw);
      
      return {
        id: dirName,
        name: frontmatter.name || dirName,
        description: frontmatter.description || '',
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        allowedTools: frontmatter['allowed-tools'],
        content,
        path: resolve(filePath, '..'),
        installed: source !== 'market',
        enabled: this.enabledSkills.has(dirName),
        source,
      };
    } catch (err: any) {
      console.error(`[Skills] 解析 ${filePath} 失败:`, err.message);
      return null;
    }
  }

  /**
   * 解析 YAML frontmatter + Markdown
   */
  private parseFrontmatter(raw: string): { frontmatter: Record<string, any>; content: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { frontmatter: {}, content: raw };
    }
    
    const fmRaw = match[1];
    const content = match[2];
    const frontmatter: Record<string, any> = {};
    
    // 简单 YAML 解析（key: value）
    for (const line of fmRaw.split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) {
        const key = m[1];
        let val: any = m[2].trim();
        // 去引号
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        frontmatter[key] = val;
      }
    }
    
    return { frontmatter, content };
  }

  /**
   * 列出所有已安装技能
   */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取技能
   */
  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /**
   * 启用/禁用技能
   */
  setEnabled(id: string, enabled: boolean) {
    if (enabled) {
      this.enabledSkills.add(id);
    } else {
      this.enabledSkills.delete(id);
    }
    const skill = this.skills.get(id);
    if (skill) skill.enabled = enabled;
    this.saveState();
  }

  /**
   * 卸载技能（删除目录）
   */
  uninstall(id: string): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;
    
    try {
      rmSync(skill.path, { recursive: true, force: true });
      this.skills.delete(id);
      this.enabledSkills.delete(id);
      this.saveState();
      console.log(`[Skills] 已卸载: ${id}`);
      return true;
    } catch (err: any) {
      console.error(`[Skills] 卸载失败:`, err.message);
      return false;
    }
  }

  /**
   * 安装技能（从内容创建）
   */
  installFromContent(id: string, skillMdContent: string): boolean {
    const skillDir = join(this.skillsDir, id);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
    
    const skillMdPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillMdPath, skillMdContent, 'utf-8');
    
    // 重新扫描
    this.scanLocal();
    console.log(`[Skills] 已安装: ${id}`);
    return true;
  }

  /**
   * 从 agentskills.io 浏览可用技能
   */
  async browseMarket(): Promise<SkillMarketItem[]> {
    try {
      const res = await fetch('https://agentskills.io/api/skills', {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any[];
      
      return data.map(item => ({
        name: item.name,
        description: item.description || '',
        author: item.metadata?.author,
        version: item.metadata?.version,
        license: item.license,
        url: item.url || item.repo || `https://agentskills.io/skills/${item.name}`,
        installed: this.skills.has(item.name),
      }));
    } catch (err: any) {
      console.error('[Skills] 市场浏览失败:', err.message);
      return [];
    }
  }

  /**
   * 从市场安装技能
   */
  async installFromMarket(skillName: string): Promise<boolean> {
    try {
      // 从 agentskills.io 获取 SKILL.md 内容
      const res = await fetch(`https://agentskills.io/api/skills/${skillName}/download`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();
      
      return this.installFromContent(skillName, content);
    } catch (err: any) {
      console.error(`[Skills] 安装 ${skillName} 失败:`, err.message);
      return false;
    }
  }

  /**
   * 创建新技能（开发者模式）
   */
  createSkill(id: string, name: string, description: string, content: string): boolean {
    const skillMd = `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n${content}`;
    return this.installFromContent(id, skillMd);
  }

  /**
   * 加载启用的技能到 Agent
   */
  getEnabledSkills(): Skill[] {
    return this.list().filter(s => s.enabled);
  }

  /**
   * 保存状态
   */
  private saveState() {
    try {
      const data = { enabled: Array.from(this.enabledSkills) };
      writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error('[Skills] 保存状态失败:', err.message);
    }
  }

  /**
   * 加载状态
   */
  private loadState() {
    try {
      if (!existsSync(this.stateFile)) return;
      const data = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      this.enabledSkills = new Set(data.enabled || []);
    } catch {
      // ignore
    }
  }
}