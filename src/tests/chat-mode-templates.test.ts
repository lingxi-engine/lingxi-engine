/**
 * B5/B11/B12 回归测试：群聊模式模板系统
 *
 * 锁死不变式：
 *   1. B11: 缺失变量渲染为空串，{{var}} 不得原样进入 prompt
 *   2. B12: mode/phase 白名单（与 admin.html phasesByMode 一致），__proto__ 污染被拒，
 *      template 非字符串被拒
 *   3. B5: 删除持久化后文件不含已删键、含 __deleted__ 墓碑清单；
 *      重启（全新模块实例）不复活；渲染回退被墓碑阻断；重设清除墓碑；
 *      删除不得污染内置 DEFAULT_TEMPLATES（浅拷贝共享引用陷阱）
 *
 * 实现说明：模块按 process.cwd()/config 读写文件，vitest worker 线程不能 chdir，
 * 故用 vi.mock('fs') 提供内存文件系统，vi.resetModules() 模拟重启。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';

const fsMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT: ' + p);
      return files.get(p);
    },
    writeFileSync: (p: string, data: string) => { files.set(p, String(data)); },
    watchFile: () => {},
    unwatchFile: () => {},
  };
});
vi.mock('fs', () => fsMock);

const CONFIG_PATH = join(process.cwd(), 'config', 'chat-mode-templates.json');
const MOD_PATH = '../core/chat-mode-templates.js';

async function freshImport() {
  vi.resetModules();
  return await import(MOD_PATH);
}

function readConfigFile(): any {
  return JSON.parse(fsMock.files.get(CONFIG_PATH) || '{}');
}

beforeEach(() => {
  fsMock.files.clear();
});

describe('B11: 缺失变量渲染为空串', () => {
  it('缺失变量不留 {{var}}', async () => {
    const m = await freshImport();
    const { prompt } = m.renderPrompt('free', 'fallback', { chatId: 'c1', content: '你好', senderId: 'u1' });
    expect(prompt).not.toContain('{{');
    expect(prompt).toContain('你好');
  });

  it('数组变量 join、对象变量 JSON 化（既有行为不回归）', async () => {
    const m = await freshImport();
    m.setTemplate('free', 'fallback', { template: 'A={{options}} B={{topic}}' });
    const { prompt } = m.renderPrompt('free', 'fallback', { chatId: 'c', content: '', senderId: 'u', options: ['x', 'y'], topic: 'T' });
    expect(prompt).toBe('A=x, y B=T');
  });
});

describe('B12: 白名单与类型校验', () => {
  it('isValidTemplateMode/Phase 与 admin.html phasesByMode 一致', async () => {
    const m = await freshImport();
    expect(m.isValidTemplateMode('roundtable')).toBe(true);
    expect(m.isValidTemplatePhase('brainstorm', 'diverge')).toBe(true);
    expect(m.isValidTemplatePhase('free', 'stance')).toBe(false);
    expect(m.isValidTemplateMode('__proto__')).toBe(false);
    expect(m.isValidTemplateMode('constructor')).toBe(false);
    expect(m.isValidTemplateMode('toString')).toBe(false);
  });

  it('setTemplate 拒绝 __proto__ 且不污染原型', async () => {
    const m = await freshImport();
    expect(() => m.setTemplate('__proto__', 'polluted', { template: 'evil' })).toThrow(TypeError);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('setTemplate 拒绝非法阶段', async () => {
    const m = await freshImport();
    expect(() => m.setTemplate('free', 'nonexistent', { template: 'x' })).toThrow(TypeError);
  });

  it('setTemplate/updateTemplate 拒绝非字符串 template', async () => {
    const m = await freshImport();
    expect(() => m.setTemplate('free', 'fallback', { template: 123 })).toThrow(TypeError);
    expect(() => m.updateTemplate('free', 'fallback', { template: null })).toThrow(TypeError);
    expect(() => m.setTemplate('free', 'fallback', {})).toThrow(TypeError);
  });

  it('deleteTemplate 拒绝 __proto__.toString 注入且原型完好', async () => {
    const m = await freshImport();
    expect(() => m.deleteTemplate('__proto__', 'toString')).toThrow(TypeError);
    expect(typeof ({} as any).toString).toBe('function');
  });

  it('合法输入正常保存', async () => {
    const m = await freshImport();
    m.setTemplate('roundtable', 'round', { template: '合法 {{content}}' });
    expect(m.getTemplate('roundtable', 'round').template).toBe('合法 {{content}}');
  });
});

describe('B5: 删除持久化与墓碑机制', () => {
  it('删除内置模板：写盘剔除键 + 持久化墓碑清单', async () => {
    const m = await freshImport();
    expect(m.deleteTemplate('debate', 'stance', true)).toBe(true);
    const file = readConfigFile();
    expect(file.debate?.stance).toBeUndefined();
    expect(file.__deleted__).toContain('debate.stance');
    expect(file.debate?.summary).toBeDefined(); // 其他模板保留
  });

  it('删除后渲染不回退到内置默认（prompt 为空）', async () => {
    const m = await freshImport();
    m.deleteTemplate('debate', 'stance', true);
    const { prompt } = m.renderPrompt('debate', 'stance', { chatId: 'c', content: 'x', senderId: 'u' });
    expect(prompt).toBe('');
    expect(m.getTemplate('debate', 'stance')).toBeUndefined();
  });

  it('删除不污染内置 DEFAULT_TEMPLATES（克隆后删除）', async () => {
    const m = await freshImport();
    m.deleteTemplate('debate', 'stance', true);
    expect(m.getDefaultTemplates().debate.stance).toBeDefined();
  });

  it('模拟重启：墓碑恢复，内置模板不复活', async () => {
    const m = await freshImport();
    m.deleteTemplate('debate', 'stance', true);
    const m2 = await freshImport(); // 全新模块实例读同一份"磁盘"文件
    expect(m2.getTemplate('debate', 'stance')).toBeUndefined();
    const { prompt } = m2.renderPrompt('debate', 'stance', { chatId: 'c', content: 'x', senderId: 'u' });
    expect(prompt).toBe('');
    expect(m2.getTemplate('debate', 'summary')).toBeDefined();
  });

  it('重新设置模板清除墓碑，重启后新模板可见', async () => {
    const m = await freshImport();
    m.deleteTemplate('debate', 'stance', true);
    m.setTemplate('debate', 'stance', { template: '新立场 {{content}}' }, true);
    const file = readConfigFile();
    expect(file.__deleted__).not.toContain('debate.stance');
    expect(file.debate.stance.template).toContain('新立场');
    const m2 = await freshImport();
    expect(m2.getTemplate('debate', 'stance').template).toContain('新立场');
  });

  it('自定义模板删除后重启同样不复活', async () => {
    const m = await freshImport();
    m.setTemplate('free', 'fallback', { template: '自定义 {{content}}' }, true);
    m.deleteTemplate('free', 'fallback', true);
    const m2 = await freshImport();
    expect(m2.getTemplate('free', 'fallback')).toBeUndefined();
    expect(m2.renderPrompt('free', 'fallback', { chatId: 'c', content: 'x', senderId: 'u' }).prompt).toBe('');
  });

  it('不存在的模板删除返回 false', async () => {
    const m = await freshImport();
    expect(m.deleteTemplate('free', 'fallback', false)).toBe(true); // 内置默认存在
    expect(m.deleteTemplate('free', 'fallback', false)).toBe(false); // 已删
  });

  it('恶意墓碑清单（__proto__.x）被过滤，不污染原型', async () => {
    fsMock.files.set(CONFIG_PATH, JSON.stringify({ __deleted__: ['__proto__.polluted', 'constructor.prototype.evil', 'debate.stance', 42, 'nodot'] }));
    const m = await freshImport();
    expect(({} as any).polluted).toBeUndefined();
    expect(m.getTemplate('debate', 'stance')).toBeUndefined(); // 合法墓碑仍生效
    expect(m.getTemplate('debate', 'summary')).toBeDefined();
  });

  it('saveTemplates 保留文件中不认识的字段（既有行为不回归）', async () => {
    fsMock.files.set(CONFIG_PATH, JSON.stringify({ customUnknownField: { keep: true } }));
    const m = await freshImport();
    m.setTemplate('free', 'fallback', { template: 'x' }, true);
    const file = readConfigFile();
    expect(file.customUnknownField).toEqual({ keep: true });
  });
});
