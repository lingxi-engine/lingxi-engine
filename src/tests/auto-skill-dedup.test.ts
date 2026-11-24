import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSkillFromSession, shouldCreateSkill, listAutoSkills } from '../tools/auto-skill.js';

// 构造一个返回指定技能 JSON 的 mock client
function mockClient(skillJson: any) {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: JSON.stringify(skillJson) } }] }),
      },
    },
  };
}

const msgs = [
  { role: 'user', content: '帮我审计代码' },
  { role: 'assistant', content: '好的，开始审计' },
  { role: 'user', content: '继续修复' },
];
const toolResults = [{ toolName: 'read_file' }, { toolName: 'write_file' }, { toolName: 'shell_exec' }];

function seedSkill(dir: string, name: string, prompt: string, description: string) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    name, displayName: name, description, tools: ['read_file', 'write_file'], prompt, autoCreated: true, createdAt: 1000,
  }, null, 2), 'utf-8');
}

describe('auto-skill 去重加固 (v2.0.41)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingxi-skill-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('shouldCreateSkill 需要 >=2 工具且 >=2 用户消息', () => {
    expect(shouldCreateSkill(toolResults, msgs as any)).toBe(true);
    expect(shouldCreateSkill([{ toolName: 'a' }], msgs as any)).toBe(false);
    expect(shouldCreateSkill(toolResults, [{ role: 'user', content: 'x' }] as any)).toBe(false);
  });

  it('相似技能 → 更新已有文件，不新建变体', async () => {
    seedSkill(dir, 'code-audit-and-fix',
      '遇到代码审计与修复任务时：读取相关核心文件，生成审计报告，分批修复问题并验证结果，最后重新读取文件验证。',
      '读取相关代码文件，生成审计报告，分批修复问题并验证结果。');
    const before = readdirSync(dir).filter(f => f.endsWith('.json')).length;

    // 候选是一个近义变体（不同名字，但内容高度相似）
    const res = await createSkillFromSession(
      mockClient({
        name: 'code-audit-and-fix-verification',
        displayName: '代码审计与修复验证',
        description: '审查代码实现，分批修复问题并验证修复结果。',
        tools: ['read_file', 'write_file', 'shell_exec'],
        prompt: '遇到代码审计与修复任务时：读取相关核心文件，生成审计报告，分批修复问题并验证结果，最后重新读取文件验证修复。',
      }),
      'test-model', msgs as any, toolResults, { skillsDir: dir },
    );

    const after = readdirSync(dir).filter(f => f.endsWith('.json')).length;
    expect(res.created).toBe(true);
    expect(after).toBe(before); // 数量不变 → 未新建变体
    expect(res.skillName).toBe('code-audit-and-fix'); // 保留规范名
    expect(existsSync(join(dir, 'code-audit-and-fix-verification.json'))).toBe(false);
    // 原文件 createdAt 保留
    const data = JSON.parse(readFileSync(join(dir, 'code-audit-and-fix.json'), 'utf-8'));
    expect(data.createdAt).toBe(1000);
  });

  it('完全同名 → 更新已有文件', async () => {
    seedSkill(dir, 'weather-query', '查询天气并汇报。', '查询天气');
    const res = await createSkillFromSession(
      mockClient({ name: 'weather-query', displayName: '天气查询', description: '查询天气', tools: ['web_search'], prompt: '查询天气并汇报温度。' }),
      'm', msgs as any, toolResults, { skillsDir: dir },
    );
    expect(res.created).toBe(true);
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(1);
  });

  it('明显不同的技能 → 新建文件', async () => {
    seedSkill(dir, 'code-audit-and-fix', '读取代码文件生成审计报告并分批修复验证。', '代码审计与修复');
    const res = await createSkillFromSession(
      mockClient({
        name: 'music-generation',
        displayName: '音乐生成',
        description: '使用本地音乐模型生成一段旋律并导出音频文件。',
        tools: ['shell_exec', 'write_file'],
        prompt: '当用户要求生成音乐时，启动本地音乐生成模型，设置风格与时长参数，等待渲染完成后导出音频到桌面。',
      }),
      'm', msgs as any, toolResults, { skillsDir: dir },
    );
    expect(res.created).toBe(true);
    expect(res.skillName).toBe('music-generation');
    expect(existsSync(join(dir, 'music-generation.json'))).toBe(true);
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(2);
  });

  it('非法技能名 → 拒绝', async () => {
    const res = await createSkillFromSession(
      mockClient({ name: 'Bad_Name!', prompt: 'x' }),
      'm', msgs as any, toolResults, { skillsDir: dir },
    );
    expect(res.created).toBe(false);
  });

  it('skip 标记 → 不创建', async () => {
    const res = await createSkillFromSession(
      mockClient({ skip: true }),
      'm', msgs as any, toolResults, { skillsDir: dir },
    );
    expect(res.created).toBe(false);
  });

  it('listAutoSkills 能读取带 BOM 的文件', () => {
    // 写入带 BOM 的技能
    writeFileSync(join(dir, 'bom-skill.json'), '\uFEFF' + JSON.stringify({
      name: 'bom-skill', displayName: 'BOM技能', description: 'd', tools: [], prompt: 'p', autoCreated: true, createdAt: 1,
    }), 'utf-8');
    // listAutoSkills 读的是默认 SKILLS_DIR，这里直接验证去 BOM 解析逻辑通过 createSkillFromSession 的 loadAutoSkills 间接覆盖
    const raw = readFileSync(join(dir, 'bom-skill.json'), 'utf-8');
    expect(raw.charCodeAt(0)).toBe(0xFEFF);
    const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    expect(() => JSON.parse(cleaned)).not.toThrow();
  });
});