/**
 * 自动技能创建（Auto Skill Creation）
 * 
 * 当 AI 完成一次包含工具调用的复杂任务后，
 * 自动总结经验写一个技能文件到 skills/ 目录，
 * 下次类似任务可以复用。
 * 
 * 参考：Hermes Agent 的 skill_manager_tool + /learn 命令
 *
 * v2.0.41 去重加固：
 *  - 旧版只查「完全同名」，导致每次会话生成一个近义变体，
 *    长期累积出数百个同质技能（code-audit 几十个变体等）。
 *  - 现在创建前先做「相似度查重」：与已有自动技能比对
 *    （名称归一化 + 描述/提示词 token Jaccard），若命中相似技能，
 *    则更新该已有技能而非新建变体，从而把技能库收敛到规范集合。
 *  - 另设自动技能数量上限，防止无界增长。
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(process.cwd(), 'skills');

// 自动技能数量上限（超过且无相似可更新时，跳过创建）
const MAX_AUTO_SKILLS = 150;
// 相似度阈值：token Jaccard >= 此值视为同一技能，更新而非新建
const SIMILARITY_THRESHOLD = 0.5;

// 确保技能目录存在
try { if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}

/**
 * 判断一次对话是否值得创建技能
 * 条件：使用了工具 + 对话超过 3 轮 + 有实质性内容
 */
export function shouldCreateSkill(toolResults: any[], messages: Array<{ role: string; content: string }>): boolean {
  if (toolResults.length < 2) return false;
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length < 2) return false;
  return true;
}

/** 提取文本 token 集合：英文单词 + 中文二元组（用于相似度比较） */
function tokenSet(text: string): Set<string> {
  const t = new Set<string>();
  const lower = (text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length > 1) t.add(m[0]);
  }
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) t.add(cjk.slice(i, i + 2));
  return t;
}

/** Jaccard 相似度 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 名称归一化签名：去连接词/填充词后排序，用于快速判重 */
const NAME_STOP = new Set(['and', 'the', 'a', 'an', 'to', 'for', 'of', 'with', 'in', 'on', 'or', 'workflow', 'task', 'helper', 'assistant', 'executor', 'runner', 'loop', 'pipeline']);
function nameSignature(name: string): string {
  return (name || '').toLowerCase().split('-').filter(w => w && !NAME_STOP.has(w)).sort().join('|');
}

interface ExistingSkill { file: string; name: string; displayName: string; description: string; prompt: string; tools: string[]; createdAt: number; tokens: Set<string>; sig: string; }

/** 读取目录下所有自动创建的技能 */
function loadAutoSkills(dir: string): ExistingSkill[] {
  const out: ExistingSkill[] = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      let raw = readFileSync(join(dir, f), 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去 BOM
      const d = JSON.parse(raw);
      if (!d.autoCreated) continue;
      out.push({
        file: f,
        name: d.name || f.replace('.json', ''),
        displayName: d.displayName || '',
        description: d.description || '',
        prompt: d.prompt || '',
        tools: Array.isArray(d.tools) ? d.tools : [],
        createdAt: d.createdAt || 0,
        tokens: tokenSet(`${d.name || ''} ${d.displayName || ''} ${d.description || ''} ${d.prompt || ''}`),
        sig: nameSignature(d.name || f.replace('.json', '')),
      });
    } catch { /* skip invalid */ }
  }
  return out;
}

/**
 * 在已有自动技能中查找与候选最相似的一个。
 * 返回相似度 >= 阈值的最相似技能；无则返回 null。
 */
function findSimilarSkill(existing: ExistingSkill[], cand: { name: string; displayName: string; description: string; prompt: string }): ExistingSkill | null {
  const candTokens = tokenSet(`${cand.name} ${cand.displayName} ${cand.description} ${cand.prompt}`);
  const candSig = nameSignature(cand.name);
  let best: ExistingSkill | null = null;
  let bestScore = 0;
  for (const s of existing) {
    // 完全同名或归一化签名相同 → 直接视为同一技能
    if (s.name === cand.name || (candSig && s.sig === candSig)) return s;
    const score = jaccard(candTokens, s.tokens);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= SIMILARITY_THRESHOLD ? best : null;
}

/**
 * 让 AI 总结这次任务的经验，生成一个技能文件
 */
export async function createSkillFromSession(
  client: any,
  model: string,
  messages: Array<{ role: string; content: string }>,
  toolResults: any[],
  options: {
    skillsDir?: string;
    onCreated?: (skillName: string, path: string) => void;
  } = {}
): Promise<{ created: boolean; skillName?: string; path?: string; error?: string }> {
  const dir = options.skillsDir || SKILLS_DIR;

  // 提取对话和工具使用的摘要
  const conversationSummary = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n')
    .slice(0, 3000);

  const toolsUsed = [...new Set(toolResults.map(r => r.toolName))].join(', ');

  const prompt = `你是一个技能总结助手。请分析以下对话和工具使用记录，判断是否值得创建一个可复用的技能文件。

判断标准：
- 任务涉及多步工具调用（搜索→分析→输出等）
- 任务模式可复用（不是一次性的特殊需求）
- 技能描述应该简洁，让 AI 下次遇到类似任务时知道该怎么做

如果值得创建，输出一个技能文件（JSON 格式）：
{
  "name": "技能名（英文，kebab-case）",
  "displayName": "中文显示名",
  "description": "一句话描述",
  "tools": ["需要的工具名"],
  "prompt": "技能指导 prompt，告诉 AI 遇到这类任务该怎么做"
}

如果不值得创建（太简单或太特殊），返回 {"skip": true}

对话记录：
---
${conversationSummary}
---

使用的工具: ${toolsUsed}
工具调用次数: ${toolResults.length}

请输出 JSON（不要加其他文字）：`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const content = response.choices[0].message.content || '';
    
    // 尝试解析 JSON
    let skillData: any;
    try {
      // 去掉可能的 markdown 代码块标记
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      skillData = JSON.parse(cleaned);
    } catch {
      return { created: false, error: 'AI 返回的 JSON 无法解析' };
    }

    if (skillData.skip) {
      return { created: false, error: 'AI 判断不需要创建技能' };
    }

    if (!skillData.name || !skillData.prompt) {
      return { created: false, error: '技能数据不完整' };
    }

    // v2 安全校验：skill 名称必须是 kebab-case 字母数字
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(skillData.name)) {
      return { created: false, error: 'AI 生成的技能名无效: ' + skillData.name };
    }

    // ── v2.0.41 去重加固 ──────────────────────────────────────────
    const existing = loadAutoSkills(dir);
    const similar = findSimilarSkill(existing, {
      name: skillData.name,
      displayName: skillData.displayName || '',
      description: skillData.description || '',
      prompt: skillData.prompt,
    });

    let skillPath: string;
    let finalName: string;
    let finalDisplayName: string;
    let createdAt: number;

    if (similar) {
      // 命中相似技能：更新已有技能，保留其规范名称与创建时间，避免变体 proliferation
      skillPath = join(dir, similar.file);
      finalName = similar.name;
      finalDisplayName = similar.displayName || skillData.displayName || similar.name;
      createdAt = similar.createdAt || Date.now();
      console.log(`[AutoSkill] 命中相似技能，更新已有: ${similar.name} (候选 ${skillData.name})`);
    } else {
      // 无相似：检查数量上限，防止无界增长
      if (existing.length >= MAX_AUTO_SKILLS) {
        return { created: false, error: `自动技能已达上限 ${MAX_AUTO_SKILLS}，跳过创建` };
      }
      skillPath = join(dir, `${skillData.name}.json`);
      finalName = skillData.name;
      finalDisplayName = skillData.displayName || skillData.name;
      createdAt = Date.now();
    }

    // 写入技能文件（更新时保留原 createdAt）
    writeFileSync(skillPath, JSON.stringify({
      name: finalName,
      displayName: finalDisplayName,
      description: skillData.description || '',
      tools: skillData.tools || [],
      prompt: skillData.prompt,
      autoCreated: true,
      createdAt,
    }, null, 2), 'utf-8');

    console.log(`[AutoSkill] ${similar ? '更新' : '自动创建'}技能: ${finalName} -> ${skillPath}`);
    
    if (options.onCreated) {
      options.onCreated(finalName, skillPath);
    }

    return { created: true, skillName: finalName, path: skillPath };
  } catch (err: any) {
    console.error('[AutoSkill] 创建失败:', err.message);
    return { created: false, error: err.message };
  }
}

/**
 * 列出所有自动创建的技能
 */
export function listAutoSkills(): Array<{ name: string; displayName: string; description: string }> {
  const dir = SKILLS_DIR;
  if (!existsSync(dir)) return [];
  
  const skills: Array<{ name: string; displayName: string; description: string }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      let raw = readFileSync(join(dir, file), 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去 BOM
      const data = JSON.parse(raw);
      if (data.autoCreated) {
        skills.push({ name: data.name, displayName: data.displayName, description: data.description });
      }
    } catch { /* skip invalid */ }
  }
  return skills;
}