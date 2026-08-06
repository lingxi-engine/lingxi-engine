/**
 * 自动技能创建（Auto Skill Creation）
 * 
 * 当 AI 完成一次包含工具调用的复杂任务后，
 * 自动总结经验写一个技能文件到 skills/ 目录，
 * 下次类似任务可以复用。
 * 
 * 参考：Hermes Agent 的 skill_manager_tool + /learn 命令
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(process.cwd(), 'skills');

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

    // 检查是否已存在同名技能
    const skillPath = join(dir, `${skillData.name}.json`);
    if (existsSync(skillPath)) {
      // 已存在，更新它
      console.log(`[AutoSkill] 更新已有技能: ${skillData.name}`);
    }

    // 写入技能文件
    writeFileSync(skillPath, JSON.stringify({
      name: skillData.name,
      displayName: skillData.displayName || skillData.name,
      description: skillData.description || '',
      tools: skillData.tools || [],
      prompt: skillData.prompt,
      autoCreated: true,
      createdAt: Date.now(),
    }, null, 2), 'utf-8');

    console.log(`[AutoSkill] 自动创建技能: ${skillData.name} -> ${skillPath}`);
    
    if (options.onCreated) {
      options.onCreated(skillData.name, skillPath);
    }

    return { created: true, skillName: skillData.name, path: skillPath };
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
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (data.autoCreated) {
        skills.push({ name: data.name, displayName: data.displayName, description: data.description });
      }
    } catch { /* skip invalid */ }
  }
  return skills;
}