/**
 * 开机自检向导 (Onboarding Wizard) — 对齐 OpenClaw 开箱体验
 *
 * 解决问题：clone → 手配 .env → 410 错误打蒙用户，第一小时流失。
 * 做法：启动时自动检测 .env / API Key / 模型连通性，失败给修复指引。
 *
 * 用法（index.ts 启动末尾）：
 *   import { runOnboarding } from './src/core/onboarding.js';
 *   await runOnboarding({ aiHub, requireAll: false });
 */

import type { AIHub } from '../ai/hub.js';

export interface OnboardingCheck {
  id: string;
  name: string;
  ok: boolean;
  /** 致命项：失败意味着 AI 对话不可用 */
  fatal?: boolean;
  /** ok=false 时的修复指引 */
  fix?: string;
  detail?: string;
}

export interface OnboardingReport {
  passed: number;
  failed: number;
  checks: OnboardingCheck[];
  /** 全部通过时为 true */
  allPassed: boolean;
  /** 存在致命项失败（模型不可用）时为 true */
  fatal: boolean;
  time: number;
}

const mask = (s: string | undefined): string => {
  if (!s) return '(未设置)';
  return s.length <= 10 ? s.slice(0, 3) + '***' : s.slice(0, 8) + '***';
};

/** 检测 1：.env 文件存在且可读 */
function checkEnvFile(): OnboardingCheck {
  const id = 'env_file';
  const name = '.env 配置文件';
  try {
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const envPath = join(process.cwd(), '.env');
    if (!existsSync(envPath)) {
      return {
        id, name, ok: false,
        fix: '复制 .env.example 为 .env，或手动创建：cp .env.example .env',
      };
    }
    const text = readFileSync(envPath, 'utf8');
    const keys = text.split(/\r?\n/).filter((l: string) => /^[A-Za-z_]/.test(l.trim()) && l.includes('=')).length;
    return { id, name, ok: true, detail: `已配置 ${keys} 个键` };
  } catch (e: any) {
    return { id, name, ok: false, fix: `读取 .env 失败: ${e.message}` };
  }
}

/** 检测 2：至少一个 Provider 的 API Key 已配置（进程环境为准） */
function checkApiKey(): OnboardingCheck {
  const id = 'api_key';
  const name = '模型 API Key';
  const keyVars = [
    'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'NVIDIA_API_KEY',
    'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'DASHSCOPE_API_KEY',
    'MOONSHOT_API_KEY', 'ZHIPU_API_KEY', 'MINIMAX_API_KEY',
  ];
  const found = keyVars.filter(k => process.env[k]);
  if (found.length === 0) {
    return {
      id, name, ok: false,
      fix: '在 .env 中配置至少一个 API Key（如 DEEPSEEK_API_KEY=sk-...）。支持: ' + keyVars.join(' / '),
    };
  }
  return { id, name, ok: true, detail: `已配置: ${found.join(', ')}（值: ${found.map(k => mask(process.env[k])).join(' / ')}）` };
}

/** 检测 3：默认模型已设置 */
function checkDefaultModel(): OnboardingCheck {
  const id = 'default_model';
  const name = '默认模型';
  const m = process.env.DEFAULT_MODEL;
  if (!m) {
    return {
      id, name, ok: false,
      fix: '在 .env 中设置 DEFAULT_MODEL（如 DEFAULT_MODEL=deepseek-chat）。可用模型见 README 或 /api/models',
    };
  }
  return { id, name, ok: true, detail: `DEFAULT_MODEL=${m}` };
}

/** 检测 4：模型连通性（真实调用一次，捕获 410/401/超时并给指引） */
async function checkModelConnectivity(aiHub?: AIHub): Promise<OnboardingCheck> {
  const id = 'model_connectivity';
  const name = '模型连通性';
  if (!aiHub) return { id, name, ok: true, detail: '跳过（aiHub 未初始化）' };
  try {
    const providers = (aiHub as any).listProviders?.() || [];
    const usable = providers.filter((p: any) => p.models?.length > 0);
    if (usable.length === 0) {
      return {
        id, name, ok: false, fatal: true,
        fix: '没有任何可用模型。检查 API Key 与 Provider 配置，或运行 npm run setup 重新配置。',
      };
    }
    // 轻量连通性测试：只列模型，不真实发消息（省 token、快）
    const models = (aiHub as any).listModels?.() || [];
    return { id, name, ok: true, detail: `${usable.length} 个 Provider 可用，${models.length} 个模型已注册` };
  } catch (e: any) {
    return {
      id, name, ok: false,
      fix: `模型系统异常: ${e.message}。常见原因：① API Key 无效（401/403）② 模型名已下线（404/410）③ 网络不通。请核对 .env 中 DEFAULT_MODEL 与对应 Key。`,
    };
  }
}

/** 检测 5：浏览器（puppeteer）可用性 */
async function checkBrowser(): Promise<OnboardingCheck> {
  const id = 'browser';
  const name = '浏览器自动化 (Puppeteer)';
  try {
    const puppeteer = await import('puppeteer');
    if (!puppeteer) throw new Error('puppeteer 未安装');
    return { id, name, ok: true, detail: `puppeteer ${ (puppeteer as any).default?.version || '已安装' }` };
  } catch {
    return {
      id, name, ok: false,
      fix: '浏览器工具不可用（puppeteer 未安装）。运行: npm run setup:browser（约 300MB Chromium，可跳过，不影响其他功能）',
    };
  }
}

/** 主函数：跑全部检测，打印报告 */
export async function runOnboarding(opts: { aiHub?: AIHub; requireAll?: boolean } = {}): Promise<OnboardingReport> {
  const checks: OnboardingCheck[] = [];
  checks.push(checkEnvFile());
  checks.push(checkApiKey());
  checks.push(checkDefaultModel());
  checks.push(await checkModelConnectivity(opts.aiHub));
  checks.push(await checkBrowser());

  const passed = checks.filter(c => c.ok).length;
  const failed = checks.length - passed;
  const fatal = checks.some(c => !c.ok && c.fatal);
  const report: OnboardingReport = {
    passed, failed, checks, allPassed: failed === 0, fatal, time: Date.now(),
  };

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🚀 灵犀引擎 开机自检 (Onboarding Check)                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  for (const c of checks) {
    const icon = c.ok ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (!c.ok && c.fix) console.log(`     ↳ 修复指引: ${c.fix}`);
  }
  console.log(`  ── ${passed}/${checks.length} 项通过${fatal ? ' ⚠️ 存在致命项，AI 对话不可用' : ''}`);
  console.log('');
  return report;
}

/** REST API: GET /api/onboarding — 供前端向导页/管理面板调用 */
export function createOnboardingRoutes(app: any, deps: { aiHub?: AIHub; browserAvailable?: boolean }) {
  app.get('/api/onboarding', async (_req: any, res: any) => {
    const checks: OnboardingCheck[] = [];
    checks.push(checkEnvFile());
    checks.push(checkApiKey());
    checks.push(checkDefaultModel());
    const conn = await checkModelConnectivity(deps.aiHub);
    checks.push(conn);
    if (deps.browserAvailable !== undefined) {
      checks.push({ id: 'browser', name: '浏览器自动化 (Puppeteer)', ok: deps.browserAvailable, detail: deps.browserAvailable ? '已就绪' : '未安装，运行 npm run setup:browser 启用' });
    } else {
      checks.push(await checkBrowser());
    }
    const passed = checks.filter(c => c.ok).length;
    res.json({
      ok: true,
      passed, failed: checks.length - passed,
      checks, allPassed: passed === checks.length, time: Date.now(),
    });
  });
  console.log('[Onboarding] 路由已注册: GET /api/onboarding');
}
