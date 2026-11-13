/**
 * 群聊模式 Prompt 模板系统
 * 支持外部配置文件、变量插值、模板继承
 * 
 * 设计原则：
 * 1. 模板与业务逻辑分离 - 便于非开发人员调整提示词
 * 2. 变量类型安全 - TypeScript 编译时检查
 * 3. 回退机制 - 外部配置缺失时使用内置默认模板
 * 4. 热重载支持 - 开发模式下文件变更自动生效
 */

import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { join, dirname } from 'path';

// 使用 process.cwd() 兼容 CommonJS/ESM，配置文件相对项目根目录
const CONFIG_DIR = join(process.cwd(), 'config');

// 模板变量类型定义
export interface TemplateVariables {
  // 通用变量
  chatId: string;
  content: string;
  senderId: string;
  
  // Agent 相关
  agentName?: string;
  agentPersonality?: string;
  agentDisplayName?: string;
  
  // 模式特定变量
  stance?: string;           // debate: 支持方/反对方/中立分析方/批判性思维方
  stage?: string;            // chain/brainstorm: 分析/执行/审查/优化 | 发散/收敛/汇总
  round?: number;            // roundtable/brainstorm: 当前轮次
  maxRounds?: number;        // roundtable: 最大轮次
  prevAgentName?: string;    // chain: 上一环节 Agent 名称
  options?: string[];        // vote: 选项列表
  topic?: string;            // brainstorm/vote: 议题/主题
  allReplies?: string;       // summary: 所有回复汇总
  allIdeas?: string;         // brainstorm summary: 所有点子汇总
  allVotes?: string;         // vote summary: 所有投票汇总
  agentNames?: string | string[];     // 可用 Agent 名称列表（字符串或数组）
  stepIndex?: number;        // chain: 步骤索引
}

// 模板配置结构
export interface ChatModeTemplate {
  // 模板内容（支持 {{variable}} 插值语法）
  template: string;
  // 是否强制 JSON 输出（用于结构化解析）
  forceJson?: boolean;
  // JSON Schema（当 forceJson=true 时使用）
  jsonSchema?: object;
  // Function Calling 定义（优先于 jsonSchema）
  functionCalling?: {
    name: string;
    description: string;
    parameters: object;
  };
}

// 完整模式配置
export interface ChatModeTemplates {
  // 自由模式
  free?: {
    fallback?: ChatModeTemplate;  // 兜底触发时的 prompt
  };
  // 路由模式
  route?: {
    analyze?: ChatModeTemplate;   // AI 分析路由
    fallback?: ChatModeTemplate;  // 兜底：router agent + full autonomy agents
  };
  // 辩论模式
  debate?: {
    stance?: ChatModeTemplate;    // 各立场发言
    summary?: ChatModeTemplate;   // 总结汇总
  };
  // 链式模式
  chain?: {
    first?: ChatModeTemplate;     // 第一步
    step?: ChatModeTemplate;      // 后续步骤
  };
  // 圆桌模式
  roundtable?: {
    round?: ChatModeTemplate;     // 每轮发言
    summary?: ChatModeTemplate;   // 最终总结
  };
  // 投票模式
  vote?: {
    vote?: ChatModeTemplate;      // 投票
    summary?: ChatModeTemplate;   // 开票统计
  };
  // 头脑风暴模式
  brainstorm?: {
    diverge?: ChatModeTemplate;   // 发散阶段
    converge?: ChatModeTemplate;  // 收敛阶段
    summary?: ChatModeTemplate;   // 汇总阶段
  };
}

// 内置默认模板（作为回退）
const DEFAULT_TEMPLATES: ChatModeTemplates = {
  free: {
    fallback: {
      template: `你是 {{agentDisplayName}}。用户发消息：{{content}}\n\n请根据你的性格回复：{{agentPersonality}}`,
    },
  },
  route: {
    analyze: {
      template: `你是一个路由助手。用户发的消息需要被分派给最合适的 AI 处理。

【用户消息】{{content}}

【可用的 AI】
{{agentNames}}

请直接回复你要 @ 的 AI 名字（可以多个，用逗号分隔），不要任何解释。如果都不合适，回复"none"。`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          selectedAgents: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['selectedAgents'],
      },
    },
    fallback: {
      template: `你是路由助手。分析用户消息：'{{content}}'，决定应该通知哪个 AI 处理。
可选的 AI：{{agentNames}}
请用 '@AI名字' 的格式告知需要呼叫的 AI，并简要说明原因。`,
    },
  },
  debate: {
    stance: {
      template: `【辩论模式 - 你是{{stance}}】

议题：{{content}}

请从「{{stance}}」的立场出发，进行论述。要求：
1. 清晰表明立场
2. 给出 2-3 个论据
3. 引用事实或逻辑支撑
4. 避免人身攻击，针对议题不针对人

请直接开始你的发言。`,
    },
    summary: {
      template: `【辩论总结】

以下是各方观点：
{{allReplies}}

请作为中立的总结者，归纳各方主要观点，指出共识和分歧，给出综合评价。`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          consensus: { type: 'array', items: { type: 'string' } },
          disagreements: { type: 'array', items: { type: 'string' } },
          evaluation: { type: 'string' },
        },
        required: ['consensus', 'disagreements', 'evaluation'],
      },
    },
  },
  chain: {
    first: {
      template: `【链式协作 - 第 1 步：{{stage}}】

任务：{{content}}

你是链式协作的第一步（{{stage}}）。请完成你的任务并输出结果，你的输出将交给下一步的 AI 继续处理。`,
    },
    step: {
      template: `【链式协作 - 第 {{stepIndex}} 步：{{stage}}】

原始任务：{{content}}
上一环节（{{prevAgentName}}）的产出请见上方消息。

你是{{stage}}环节，请基于上一步的结果继续推进任务。如有不满意的部分请标注出来。`,
    },
  },
  roundtable: {
    round: {
      template: `【圆桌讨论 - 第 {{round}} 轮 / 共 {{maxRounds}} 轮】

议题：{{content}}

你是参与者之一。请发表你的看法：
1. 对这个问题的理解
2. 你的建议或方案
3. 对其他成员可能的质疑点

稍后其他成员会回复你。保持开放态度。`,
    },
    summary: {
      template: `圆桌讨论已结束。请作为主持人对本次讨论做一个简洁的总结，归纳各方达成的共识和主要分歧。`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          consensus: { type: 'array', items: { type: 'string' } },
          disagreements: { type: 'array', items: { type: 'string' } },
          actionItems: { type: 'array', items: { type: 'string' } },
        },
        required: ['consensus', 'disagreements', 'actionItems'],
      },
    },
  },
  vote: {
    vote: {
      template: `【投票模式】

议题：{{content}}
选项：{{options}}

请投出你的一票。回复格式：
{
  "choice": "选项X",
  "reason": "一句话说明为什么"
}`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          choice: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['choice', 'reason'],
      },
    },
    summary: {
      template: `【投票开票】

以下是各位 AI 的投票结果：
{{allVotes}}

可选选项：{{options}}

请作为计票员：
1. 统计每个选项的得票数
2. 用表格或清单列出开票结果
3. 宣布得票最高的方案，并简述各方理由`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'object',
            additionalProperties: { type: 'integer' },
          },
          winner: { type: 'string' },
          analysis: { type: 'string' },
        },
        required: ['results', 'winner', 'analysis'],
      },
    },
  },
  brainstorm: {
    diverge: {
      template: `【头脑风暴 - 第 1 阶段：发散】

议题：{{content}}

规则（必须遵守）：
1. 只输出点子，不要解释过程
2. 禁止批评、禁止否定（包括自我否定）
3. 质大于量：给出 3-5 个具体、可执行的点子
4. 欢迎大胆、非常规的想法
5. 每个点子以「- 」开头，一句话说清

直接开始。`,
    },
    converge: {
      template: `【头脑风暴 - 第 2 阶段：收敛】

议题：{{topic}}

上方消息是各成员的第一轮点子。请：
1. 从【别人的点子】中挑 1-2 个你认为最有潜力、最值得做的
2. 各用一句话说明：为什么值得做 + 怎么补全它（补什么关键细节）
3. 也可以合并两个点子成一个更强的方案
4. 不要重复罗列自己的点子，不要客套

直接输出。`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          selectedIdeas: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                idea: { type: 'string' },
                why: { type: 'string' },
                howToComplete: { type: 'string' },
              },
              required: ['idea', 'why', 'howToComplete'],
            },
          },
          mergedIdeas: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['selectedIdeas'],
      },
    },
    summary: {
      template: `【头脑风暴 - 第 3 阶段：汇总】

议题：{{topic}}

以下是各位成员的发散与收敛意见：
{{allIdeas}}

请作为主持人输出一份头脑风暴成果：
1. 去重合并所有点子（明显重复的合并，保留表述更好的）
2. 按「可行性 × 创新性」挑出 Top 3
3. 每个入选点子给出一句落地建议（第一步做什么）
4. 最后输出「行动项」清单：编号 + 一句话

格式清晰，直接输出。`,
      forceJson: true,
      jsonSchema: {
        type: 'object',
        properties: {
          topIdeas: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                idea: { type: 'string' },
                feasibility: { type: 'number', minimum: 1, maximum: 10 },
                innovation: { type: 'number', minimum: 1, maximum: 10 },
                firstStep: { type: 'string' },
              },
              required: ['idea', 'feasibility', 'innovation', 'firstStep'],
            },
          },
          actionItems: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['topIdeas', 'actionItems'],
      },
    },
  },
};

// 外部配置文件路径
const EXTERNAL_CONFIG_PATH = join(CONFIG_DIR, 'chat-mode-templates.json');

// 模板缓存
let templateCache: ChatModeTemplates = { ...DEFAULT_TEMPLATES };

// B5: 墓碑集合 — 记录已删除的 `${mode}.${templateKey}`，持久化到配置文件 __deleted__ 字段，
// 阻止重启/热重载/渲染回退时内置默认模板"复活"
let deletedTemplates: Set<string> = new Set();

// B12: 模式/阶段白名单（与 web/admin.html 的 phasesByMode 逐字一致），阻断 '__proto__' 等原型污染
const MODE_PHASES: Record<string, readonly string[]> = {
  free: ['fallback'],
  route: ['analyze', 'fallback'],
  debate: ['stance', 'summary'],
  chain: ['first', 'step'],
  roundtable: ['round', 'summary'],
  vote: ['vote', 'summary'],
  brainstorm: ['diverge', 'converge', 'summary'],
};

/** B12: 校验模式合法性（自有属性检查，拒绝 __proto__/constructor 等） */
export function isValidTemplateMode(mode: string): boolean {
  return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODE_PHASES, mode);
}

/** B12: 校验指定模式下的阶段合法性 */
export function isValidTemplatePhase(mode: string, phase: string): boolean {
  return isValidTemplateMode(mode) && MODE_PHASES[mode].includes(phase);
}

/** B12: 输入校验（setTemplate/updateTemplate 共用），非法输入抛 TypeError */
function assertValidTemplateInput(mode: string, templateKey: string, template: ChatModeTemplate): void {
  if (!isValidTemplateMode(mode)) throw new TypeError(`非法模板模式: ${String(mode)}`);
  if (!isValidTemplatePhase(mode, templateKey)) throw new TypeError(`非法模板阶段: ${String(mode)}.${String(templateKey)}`);
  if (!template || typeof template.template !== 'string') throw new TypeError('template.template 必须为字符串');
}

/** B5: 应用墓碑 — 从缓存剔除对应键（只接受合法 mode.phase，防恶意配置文件注入；克隆后删除避免污染 DEFAULT_TEMPLATES） */
function applyTombstones(tombstones: unknown): void {
  deletedTemplates = new Set();
  if (Array.isArray(tombstones)) {
    for (const t of tombstones) {
      if (typeof t !== 'string') continue;
      const dot = t.indexOf('.');
      if (dot <= 0) continue;
      const mode = t.slice(0, dot);
      const key = t.slice(dot + 1);
      if (isValidTemplateMode(mode) && isValidTemplatePhase(mode, key)) deletedTemplates.add(t);
    }
  }
  for (const tomb of deletedTemplates) {
    const dot = tomb.indexOf('.');
    const mode = tomb.slice(0, dot);
    const key = tomb.slice(dot + 1);
    const modeConfig = (templateCache as any)[mode];
    if (modeConfig && typeof modeConfig === 'object') {
      (templateCache as any)[mode] = { ...modeConfig };
      delete (templateCache as any)[mode][key];
    }
  }
}
let configWatchers: Map<string, () => void> = new Map();
let isDevMode = process.env.NODE_ENV !== 'production';

/**
 * 简单的模板引擎：{{variable}} 替换
 */
function renderTemplate(template: string, variables: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return ''; // B11: 缺失变量替换为空串，不把 {{var}} 原样发给模型
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  });
}

/**
 * 加载外部配置文件
 */
function loadExternalConfig(): ChatModeTemplates | null {
  try {
    if (!existsSync(EXTERNAL_CONFIG_PATH)) {
      return null;
    }
    const raw = readFileSync(EXTERNAL_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ChatModeTemplates;
    console.log(`[ChatModeTemplates] 已加载外部模板配置: ${EXTERNAL_CONFIG_PATH}`);
    return parsed;
  } catch (err: any) {
    console.warn(`[ChatModeTemplates] 外部配置加载失败: ${err.message}`);
    return null;
  }
}

/**
 * 深度合并模板（外部覆盖内置）
 */
function mergeTemplates(base: ChatModeTemplates, override: ChatModeTemplates): ChatModeTemplates {
  const result = { ...base };
  for (const [mode, modeConfig] of Object.entries(override)) {
    if (!modeConfig || mode === '__deleted__') continue; // B5: 墓碑清单不是模式，不参与合并
    result[mode as keyof ChatModeTemplates] = {
      ...(base[mode as keyof ChatModeTemplates] || {}),
      ...modeConfig,
    } as any;
  }
  return result;
}

/**
 * 初始化模板系统
 */
export function initChatModeTemplates(): void {
  const external = loadExternalConfig();
  if (external) {
    templateCache = mergeTemplates(DEFAULT_TEMPLATES, external);
    applyTombstones((external as any).__deleted__); // B5: 恢复删除墓碑，防内置模板复活
  }
  
  // 开发模式：监听配置文件变化，热重载
  if (isDevMode && existsSync(EXTERNAL_CONFIG_PATH)) {
    watchFile(EXTERNAL_CONFIG_PATH, { interval: 1000 }, () => {
      console.log('[ChatModeTemplates] 检测到配置文件变更，重新加载...');
      const newExternal = loadExternalConfig();
      if (newExternal) {
        templateCache = mergeTemplates(DEFAULT_TEMPLATES, newExternal);
        applyTombstones((newExternal as any).__deleted__); // B5: 热重载同步墓碑
        console.log('[ChatModeTemplates] 热重载完成');
      }
    });
  }
}

/**
 * 获取模板（带回退）
 */
export function getTemplate<T extends keyof ChatModeTemplates>(
  mode: T,
  templateKey: string
): ChatModeTemplate | undefined {
  const modeConfig = templateCache[mode] as Record<string, ChatModeTemplate> | undefined;
  return modeConfig?.[templateKey];
}

/**
 * 渲染模板（带变量插值）
 */
export function renderPrompt(
  mode: keyof ChatModeTemplates,
  templateKey: string,
  variables: TemplateVariables
): { prompt: string; forceJson?: boolean; jsonSchema?: object; functionCalling?: any } {
  // B5: 已墓碑化的模板不再回退到内置默认，否则删除会被回退绕过
  let template = getTemplate(mode, templateKey);
  if (!template && !deletedTemplates.has(`${mode}.${templateKey}`)) {
    template = DEFAULT_TEMPLATES[mode]?.[templateKey as keyof typeof DEFAULT_TEMPLATES[keyof ChatModeTemplates]];
  }
  
  if (!template) {
    console.warn(`[ChatModeTemplates] 模板不存在: ${mode}.${templateKey}，使用空字符串`);
    return { prompt: '' };
  }
  
  const rendered = renderTemplate(template.template, variables as Record<string, any>);
  
  return {
    prompt: rendered,
    forceJson: template.forceJson,
    jsonSchema: template.jsonSchema,
    functionCalling: template.functionCalling,
  };
}

/**
 * 获取所有模板（用于管理界面）
 */
export function getAllTemplates(): ChatModeTemplates {
  return { ...templateCache };
}

/**
 * 更新模板（运行时热更新，不持久化）
 */
export function updateTemplate(
  mode: keyof ChatModeTemplates,
  templateKey: string,
  template: ChatModeTemplate
): void {
  assertValidTemplateInput(mode as string, templateKey, template); // B12: 白名单+类型校验
  if (!templateCache[mode]) {
    templateCache[mode] = {} as any;
  }
  (templateCache[mode] as Record<string, ChatModeTemplate>)[templateKey] = template;
  deletedTemplates.delete(`${mode}.${templateKey}`); // B5: 重新设置模板即清除其墓碑
  console.log(`[ChatModeTemplates] 运行时更新模板: ${mode}.${templateKey}`);
}

/**
 * 导出内置默认模板（用于生成配置文件示例）
 */
export function getDefaultTemplates(): ChatModeTemplates {
  return { ...DEFAULT_TEMPLATES };
}

/**
 * 设置模板（运行时热更新 + 可选持久化）
 */
export function setTemplate(
  mode: keyof ChatModeTemplates,
  templateKey: string,
  template: ChatModeTemplate,
  persist = false
): void {
  assertValidTemplateInput(mode as string, templateKey, template); // B12: 白名单+类型校验，阻断 __proto__ 污染
  if (!templateCache[mode]) {
    templateCache[mode] = {} as any;
  }
  (templateCache[mode] as Record<string, ChatModeTemplate>)[templateKey] = template;
  deletedTemplates.delete(`${mode}.${templateKey}`); // B5: 重新设置模板即清除其墓碑
  console.log(`[ChatModeTemplates] 更新模板: ${mode}.${templateKey}${persist ? ' (持久化)' : ''}`);

  if (persist) {
    saveTemplates();
  }
}

/**
 * 删除模板（运行时热更新 + 可选持久化）
 */
export function deleteTemplate(
  mode: keyof ChatModeTemplates,
  templateKey: string,
  persist = false
): boolean {
  // B12: 删除同样校验，防 '__proto__.x' 之类墓碑注入
  if (!isValidTemplateMode(mode as string) || !isValidTemplatePhase(mode as string, templateKey)) {
    throw new TypeError(`非法模板模式/阶段: ${String(mode)}.${String(templateKey)}`);
  }
  const modeConfig = templateCache[mode] as Record<string, ChatModeTemplate> | undefined;
  if (!modeConfig || !modeConfig[templateKey]) {
    return false;
  }
  // B5: 克隆后再删，避免共享引用污染内置 DEFAULT_TEMPLATES
  (templateCache as any)[mode] = { ...modeConfig };
  delete (templateCache as any)[mode][templateKey];
  deletedTemplates.add(`${mode}.${templateKey}`); // B5: 记录墓碑，阻断重启/回退复活
  console.log(`[ChatModeTemplates] 删除模板: ${mode}.${templateKey}${persist ? ' (持久化)' : ''}`);

  if (persist) {
    saveTemplates();
  }
  return true;
}

/**
 * 持久化模板到外部配置文件
 */
export function saveTemplates(): void {
  try {
    const configDir = join(process.cwd(), 'config');
    const filePath = join(configDir, 'chat-mode-templates.json');
    
    // 读取现有配置（保留不认识的字段）
    let existing: ChatModeTemplates = {};
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf8');
        existing = JSON.parse(raw) as ChatModeTemplates;
      } catch { /* ignore */ }
    }
    
    // 合并：运行时更新覆盖文件
    const merged = mergeTemplates(existing, templateCache);
    // B5: 显式剔除已墓碑化的键，防止文件旧键经合并"复活"已删除模板
    for (const tomb of deletedTemplates) {
      const dot = tomb.indexOf('.');
      const m = tomb.slice(0, dot);
      const k = tomb.slice(dot + 1);
      const mc = (merged as any)[m];
      if (mc && typeof mc === 'object') delete mc[k];
    }
    // B5: 持久化墓碑清单（重启/热重载时恢复删除状态）
    (merged as any).__deleted__ = Array.from(deletedTemplates);
    
    // 写入
    const json = JSON.stringify(merged, null, 2);
    writeFileSync(filePath, json, 'utf8');
    console.log('[ChatModeTemplates] 配置已持久化到', filePath);
  } catch (err: any) {
    console.error('[ChatModeTemplates] 持久化失败:', err.message);
    throw err;
  }
}

// 自动初始化
initChatModeTemplates();