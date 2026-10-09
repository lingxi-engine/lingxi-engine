/**
 * 统一数据/资源路径解析
 *
 * 背景：引擎历史上大量使用 `join(process.cwd(), 'data')` 决定数据目录，
 * 导致「同一台机器装了两份引擎 → 启动目录不同 → 数据目录不同」的脑裂问题：
 * 用户看到的会话/Provider 凭空消失，实际只是连到了另一份实例的数据。
 *
 * 规则（优先级从高到低）：
 *   1. LINGXI_DATA_DIR —— 显式指定，最高优先级
 *   2. LINGXI_HOME     —— 锁定安装根目录，data/ 挂在其下
 *   3. 回退到 process.cwd()（保持既有行为，不破坏现有部署）
 *
 * 注意：这里只做「读环境变量 + 拼路径」，不产生任何副作用，
 * 不创建目录、不写文件，保证被 import 时绝对安全。
 */
import { join, resolve } from 'path'

function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

/** 安装根目录：用于定位 data/、skills/ 等随发行版走的东西 */
export function lingxiHome(): string {
  return firstNonEmpty(process.env.LINGXI_HOME, process.cwd()) || process.cwd()
}

/**
 * 数据目录。
 * 关键点：项目根目录（tsx index.ts 的启动位置）不随当前工作目录变化，
 * 因此在未显式指定时，优先使用 index.ts 所在仓库的 data/，
 * 避免「换个目录敲 npm start 就读到另一份空库」。
 */
export function dataDir(): string {
  const explicit = firstNonEmpty(
    process.env.LINGXI_DATA_DIR,
    process.env.DATA_DIR,
  )
  if (explicit) return resolve(explicit)

  const home = firstNonEmpty(process.env.LINGXI_HOME)
  if (home) return join(resolve(home), 'data')

  // 从 import.meta.url 反推仓库根（src/core/paths.ts -> 上两级）
  try {
    const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const repoRoot = resolve(here, '..', '..')
    return join(repoRoot, 'data')
  } catch {
    return join(process.cwd(), 'data')
  }
}

/** data/ 下的某个文件 */
export function dataPath(...segments: string[]): string {
  return join(dataDir(), ...segments)
}

/** skills/ 目录 */
export function skillsDir(): string {
  return join(lingxiHome(), 'skills')
}

export function workspaceDir(): string {
  return join(lingxiHome(), 'workspace')
}
