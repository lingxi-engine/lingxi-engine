/**
 * 灵犀官网 ID 绑定模块
 * 启动时检查 LINGXI_ID，没有则引导注册/登录
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
// 云平台地址：通过 .env 的 PLATFORM_URL 配置；留空 = 纯本地模式（注册/登录会提示无法连接，不影响本地功能）
const PLATFORM_URL = process.env.PLATFORM_URL || '';

interface PlatformUser {
  ok: boolean;
  id: number;
  token: string;
  points?: number;
  role?: string;
  error?: string;
}

async function apiPost(path: string, body: any, altPaths: string[] = []): Promise<PlatformUser> {
  const tryPath = async (p: string): Promise<Response> =>
    fetch(PLATFORM_URL + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let res = await tryPath(path);
  // 404/405 → 尝试备用路径（兼容官网旧协议 /api/register）
  for (const alt of altPaths) {
    if (res.status !== 404 && res.status !== 405) break;
    res = await tryPath(alt);
  }
  const d = await res.json();
  // 协议兼容：新版返回 { user: {...} }，旧版直接返回 { id, points }
  const u = d?.user || d;
  return {
    ok: d?.ok === true,
    id: u?.id ?? d?.id ?? 0,
    token: d?.token || u?.token || '',
    points: u?.points ?? d?.points,
    role: u?.role ?? d?.role,
    error: d?.error,
  };
}

function getEnvVar(key: string): string | undefined {
  const val = process.env[key];
  if (val) return val;
  // Try reading from .env file
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
  }
  return undefined;
}

function setEnvVar(key: string, value: string) {
  let content = '';
  if (existsSync(ENV_PATH)) {
    content = readFileSync(ENV_PATH, 'utf-8');
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    if (!content.endsWith('\n')) content += '\n';
    content += `${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content, 'utf-8');
  process.env[key] = value;
}

export async function ensurePlatformId(): Promise<{ id: number; token: string } | null> {
  const existingId = getEnvVar('LINGXI_ID');
  const existingToken = getEnvVar('LINGXI_TOKEN');

  if (existingId && existingToken) {
    console.log(`[Platform] 已绑定官网 ID: ${existingId}`);
    return { id: parseInt(existingId), token: existingToken };
  }

  // 自动注册
  console.log('[Platform] 检测到未绑定官网 ID，正在自动注册...');
  const username = 'lingxi-' + Math.random().toString(36).slice(2, 8);
  const password = Math.random().toString(36).slice(2, 14);

  try {
    const result = await apiPost('/api/user/register', { username, password, displayName: username }, ['/api/register']);
    if (result.ok && result.id) {
      setEnvVar('LINGXI_ID', String(result.id));
      setEnvVar('LINGXI_TOKEN', result.token);
      console.log(`[Platform] ✅ 注册成功！ID: ${result.id}，积分: ${result.points || 500}`);
      console.log(`[Platform] 用户名: ${username}，密码: ${password}（请妥善保存）`);
      return { id: result.id, token: result.token };
    } else {
      console.error('[Platform] 注册失败:', result.error);
      return null;
    }
  } catch (err: any) {
    console.error('[Platform] 无法连接官网:', err.message);
    console.log('[Platform] 引擎仍可正常使用本地功能');
    return null;
  }
}

// CLI 手动绑定
export async function loginPlatform(username: string, password: string): Promise<PlatformUser> {
  const result = await apiPost('/api/user/login', { username, password }, ['/api/login']);
  if (result.ok) {
    setEnvVar('LINGXI_ID', String(result.id));
    setEnvVar('LINGXI_TOKEN', result.token);
    console.log(`[Platform] ✅ 登录成功！ID: ${result.id}`);
  }
  return result;
}

export async function registerPlatform(username: string, password: string, email?: string): Promise<PlatformUser> {
  const result = await apiPost('/api/user/register', { username, password, email, displayName: username }, ['/api/register']);
  if (result.ok) {
    setEnvVar('LINGXI_ID', String(result.id));
    setEnvVar('LINGXI_TOKEN', result.token);
    console.log(`[Platform] ✅ 注册成功！ID: ${result.id}`);
  }
  return result;
}

export function getPlatformConfig() {
  return {
    id: getEnvVar('LINGXI_ID'),
    token: getEnvVar('LINGXI_TOKEN'),
    url: PLATFORM_URL,
  };
}