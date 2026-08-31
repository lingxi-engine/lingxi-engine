/**
 * 白盒思考树 - Thought Tree (CoT 可视化)
 *
 * 让 AI 在回答前生成结构化的推理树，让思考过程对用户可见
 * 树结构：问题 → 分解为子问题 → 每个子问题再分解或回答 → 汇总
 */

import type OpenAI from 'openai';

export interface ThoughtNode {
  id: string;
  type: 'question' | 'decomposition' | 'reasoning' | 'answer' | 'synthesis';
  content: string;
  children: ThoughtNode[];
  /** 仅 answer 节点：置信度 0-100 */
  confidence?: number;
  /** 仅 reasoning 节点：使用的推理方法 */
  method?: string;
}

export interface ThoughtTree {
  rootQuestion: string;
  root: ThoughtNode;
  /** 整棵树的推理步数 */
  totalSteps: number;
  /** 是否有任何"不确定性"节点 */
  hasUncertainty: boolean;
}

let _nodeCounter = 0;
function genId(): string {
  return `n-${++_nodeCounter}-${Date.now().toString(36)}`;
}

/**
 * 从 AI 输出构建思考树（递归解析）
 */
export class ThoughtTreeBuilder {
  private client: OpenAI | null;
  private model: string;

  constructor(client: OpenAI | null, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * 让 AI 生成结构化的思考树
   */
  async buildTree(question: string): Promise<ThoughtTree> {
    if (!this.client) {
      return this._fallbackTree(question);
    }

    try {
      const prompt = `分析以下问题，以"思考树"形式展示推理过程。要求：
1. 把问题分解为子问题（不超过4个）
2. 每个子问题可以继续分解或直接回答
3. 推理步骤要具体、可验证
4. 如果有不确定性，明确标注

请以 JSON 格式返回，结构如下：
{
  "type": "question",
  "content": "原始问题",
  "children": [
    {
      "type": "decomposition",
      "content": "子问题1",
      "children": [
        {"type": "reasoning", "content": "推理过程", "method": "使用的方法"},
        {"type": "answer", "content": "子问题答案", "confidence": 85}
      ]
    }
  ]
}

问题：${question}`;

      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 2000,
      });

      const content = (resp.choices[0]?.message as any)?.content || (resp.choices[0]?.message as any)?.reasoning_content || '{}';
      const parsed = JSON.parse(content);
      return this._parseNode(parsed, question);
    } catch (err: any) {
      console.warn('[ThoughtTree] buildTree failed:', err.message);
      return this._fallbackTree(question);
    }
  }

  /**
   * 把树结构转成文本形式（用于注入 prompt 或显示给用户）
   */
  formatTreeAsText(tree: ThoughtTree): string {
    const lines: string[] = [`问题：${tree.rootQuestion}`, ''];
    this._formatNode(tree.root, lines, 0);
    return lines.join('\n');
  }

  /**
   * 把树结构转成 Markdown（适合前端渲染）
   */
  formatTreeAsMarkdown(tree: ThoughtTree): string {
    const lines: string[] = [`## ${tree.rootQuestion}`];
    this._formatNodeMarkdown(tree.root, lines, 0);
    lines.push(`\n> 步数：${tree.totalSteps} · ${tree.hasUncertainty ? '⚠️ 存在不确定环节' : '✅ 推理链完整'}`);
    return lines.join('\n');
  }

  /**
   * 获取最终答案（树中所有 answer 节点的合并）
   */
  getFinalAnswer(tree: ThoughtTree): string {
    const answers: string[] = [];
    this._collectAnswers(tree.root, answers);
    if (answers.length === 0) return '（未找到答案）';
    if (answers.length === 1) return answers[0];
    return answers.map((a, i) => `${i + 1}. ${a}`).join('\n');
  }

  private _parseNode(data: any, question: string): ThoughtTree {
    const node = this._nodeFromJSON(data);
    return this._buildFromRoot(node, question);
  }

  private _buildFromRoot(root: ThoughtNode, question: string): ThoughtTree {
    let steps = 0;
    let hasUncertainty = false;
    const walk = (n: ThoughtNode) => {
      steps++;
      if (n.type === 'reasoning' && n.confidence !== undefined && n.confidence < 70) {
        hasUncertainty = true;
      }
      n.children.forEach(walk);
    };
    walk(root);
    return { rootQuestion: question, root, totalSteps: steps, hasUncertainty };
  }

  private _nodeFromJSON(data: any): ThoughtNode {
    const node: ThoughtNode = {
      id: genId(),
      type: data.type || 'reasoning',
      content: data.content || '',
      children: (data.children || []).map((c: any) => this._nodeFromJSON(c)),
      confidence: data.confidence,
      method: data.method,
    };
    return node;
  }

  private _formatNode(node: ThoughtNode, lines: string[], depth: number) {
    const indent = '  '.repeat(depth);
    const icon = {
      question: '❓',
      decomposition: '🔀',
      reasoning: '💭',
      answer: '✅',
      synthesis: '🔗',
    }[node.type];
    lines.push(`${indent}${icon} ${node.content}`);
    if (node.method) lines.push(`${indent}  └─ 方法：${node.method}`);
    if (node.confidence !== undefined) {
      lines.push(`${indent}  └─ 置信度：${node.confidence}%`);
    }
    node.children.forEach(c => this._formatNode(c, lines, depth + 1));
  }

  private _formatNodeMarkdown(node: ThoughtNode, lines: string[], depth: number) {
    const indent = '  '.repeat(depth);
    const icon = {
      question: '❓',
      decomposition: '🔀',
      reasoning: '💭',
      answer: '✅',
      synthesis: '🔗',
    }[node.type];
    lines.push(`${indent}- ${icon} ${node.content}`);
    if (node.method) lines.push(`${indent}  - 方法：${node.method}`);
    if (node.confidence !== undefined) lines.push(`${indent}  - 置信度：${node.confidence}%`);
    node.children.forEach(c => this._formatNodeMarkdown(c, lines, depth + 1));
  }

  private _collectAnswers(node: ThoughtNode, answers: string[]) {
    if (node.type === 'answer' && node.confidence !== undefined && node.confidence >= 60) {
      answers.push(node.content);
    }
    node.children.forEach(c => this._collectAnswers(c, answers));
  }

  private _fallbackTree(question: string): ThoughtTree {
    const root: ThoughtNode = {
      id: genId(),
      type: 'question',
      content: question,
      children: [
        {
          id: genId(),
          type: 'reasoning',
          content: '（AI 推理过程不可用，直接回答）',
          children: [],
        },
      ],
    };
    return {
      rootQuestion: question,
      root,
      totalSteps: 1,
      hasUncertainty: true,
    };
  }
}
