# 沙盒执行 + 环境反馈闭环
#
# 对应 AGI 进化路线图【阶段3·让它"接地"】：
#   从"嘴炮"到"可验证的通用能力"——引擎不仅能讨论出方案，还能
#   在受限沙盒里实际执行动作、观察环境反馈，并据此调整下一步行动。
#
# 核心设计：
#   1. 安全执行：模式开关 + 白名单命令（首词精确匹配）+ 超时控制 + 输出捕获
#   2. 结构化结果：每条执行都返回 {ok, stdout, stderr, exit_code, elapsed}
#   3. 环境反馈闭环：run_discussion 得出行动方案后，把执行结果喂回
#      给模型形成"行动 → 观察 → 调整"的循环，而非只输出文字
#
# ── 沙盒模式开关（sandbox_mode，四档）──────────────────────────────
#   strict（默认）：安全优先。白名单只含无害查询类命令（echo/dir/ls/
#       type/cat/pwd/find/where/which/ping），不含任何解释器。
#   open（体验档）：能力优先。在 strict 基础上额外放行常用开发工具
#       （python/python3/py/node/npm/npx/pip/git/curl 等），让模型可以
#       真正跑脚本验证方案。注意：解释器一旦放行即等于任意代码执行，
#       黑名单与超时仍生效但只是纵深防御——此档应由使用者显式开启，
#       并仅在可信环境下使用。
#   full（全开放档）：跳过白名单检查，任何命令放行；仅保留黑名单兜底、
#       超时与无 shell 三道防线。能力与直接操作终端等同，适用于完全
#       可信的本机自动化场景，风险由使用者自担。
#   off：完全关闭。任何 run() 都抛 SandboxError；
#       RoleDiscussion.run_with_feedback 会返回明确的错误说明。
#
# 兼容性：
#   - enable_sandbox=False 仍然有效，且优先级最高（强制等效 off）。
#   - 显式传入 sandbox_allow 列表时完全覆盖模式对应白名单。
#   - 非法 mode 值一律回落 strict：配置写错时宁严勿松。
#
# 安全设计（所有模式下不变的部分）：
#   - 不使用 shell=True。外部命令经 Windows 友好切分（保留反斜杠、
#     支持引号分组）后以列表传给 subprocess.run，杜绝 shell 元字符注入
#     （管道/重定向/&/反引号/$()）。元字符在无 shell 环境下只是惰性文本，
#     不会被解释执行。
#   - 白名单为【首个 token 的精确匹配】，不做前缀匹配。
#   - 内建命令（echo/pwd/dir/ls/type/cat）用 Python 原生实现，
#     完全不经过子进程与 shell，跨平台行为一致且无注入面。
#     【20260824 修复】内建命令的纯文本参数只是数据（打印文本/读文件/
#     列目录），不构成执行风险，因此跳过参数级黑名单检查——否则
#     `echo rm`、`dir /s` 这类无害命令会被 token 级黑名单误伤。
#     但参数中一旦出现 shell 元字符（&& || ; | > < 反引号 $( 等
#     注入信号），视为注入尝试，恢复从严黑名单检查，拦截
#     `echo hi && rm -rf /tmp/x` 这类"看似文本实为注入"的组合。
#   - 黑名单保留为纵深防御第二层（拦【外部命令】的参数级危险操作），
#     两级匹配：
#     * token 级精确匹配：rm/del/shutdown 等词根，-delete/-exec/-ok/-rf/
#       --force 等危险标志（不会误伤 full-mode-ok 这类含子串的正常文本）；
#     * 短语级子串匹配：drop database / push --delete / rd /s 等多 token 组合。
#
# 纯 Python 实现，无外部依赖。

import os
import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional

# 合法的沙盒模式
SANDBOX_MODES = ('strict', 'open', 'full', 'off')


def _split_cmd(command: str):
    """Windows 友好的命令行切分：按空格切分，支持单/双引号分组。

    与 shlex.split(posix=True) 的关键差异：不把反斜杠当作转义符，
    因此 Windows 绝对路径（C:\\Users\\...）原样保留，不会被破坏。
    也不经过 shell，管道/重定向等元字符只是普通 token 文本。
    注意：含空格的路径需要用引号包裹（如 "C:\\Program Files\\python.exe"），
    与 Windows 命令行行为一致。
    """
    tokens = []
    cur = []
    quote = None  # None / '"' / "'"
    for ch in command:
        if quote:
            if ch == quote:
                quote = None
            else:
                cur.append(ch)
        elif ch in ('"', "'"):
            quote = ch
        elif ch == ' ':
            if cur:
                tokens.append(''.join(cur))
                cur = []
        else:
            cur.append(ch)
    if cur:
        tokens.append(''.join(cur))
    return tokens


def _default_allow() -> List[str]:
    """strict 档默认白名单：只放行无害查询类命令。"""
    return [
        # 文本输出（原生实现）
        'echo',
        # 目录列举（原生实现）
        'dir', 'ls',
        # 读文件（原生实现）
        'type', 'cat',
        # 查找/定位（外部程序）
        'find', 'where', 'which',
        # 网络探测（外部程序，只读无副作用；亦用于超时回归）
        'ping',
        # 路径（原生实现）
        'pwd',
    ]


def _default_allow_open() -> List[str]:
    """open 档默认白名单：strict 基础上放行常用开发工具。

    ⚠️ 解释器（python/node）一旦放行即等于任意代码执行入口，
    黑名单此时只是纵深防御而非硬边界。此档仅供可信环境显式开启。
    """
    base = _default_allow()
    extended = [
        # 解释器：让模型能真正跑脚本验证方案
        'python', 'python3', 'py',
        'node',
        # 包管理 / 前端工具链
        'npm', 'npx', 'pip', 'pip3',
        # 版本控制（黑名单仍拦 push --force 等破坏性标志）
        'git',
        # 网络请求（只读语义由调用方自律保证）
        'curl',
        # 媒体处理（音视频合成/转码等常见任务流）
        'ffmpeg', 'ffprobe',
        # 压缩归档
        'tar', 'unzip', 'gzip',
        # 远程传输
        'ssh', 'scp',
    ]
    # 去重保序
    seen = set(base)
    for cmd in extended:
        if cmd not in seen:
            base.append(cmd)
            seen.add(cmd)
    return base


# 参数级危险操作黑名单（纵深防御第二层，所有模式生效）。
# 白名单已保证首词无害，这里主要拦"无害命令 + 危险参数"的组合，
# 如 `git push --force`、`find . -delete` 这类破坏性子命令/标志。
# 【注意】该检查对原生内建命令（echo/pwd/dir/ls/type/cat）仅在
# 参数含 shell 元字符（注入信号）时生效；纯文本参数只是数据，
# 在 _check_permission 中直接放行，不经过本黑名单。
# 两级匹配避免子串误伤（例如 -ok 不应命中 full-mode-ok）：
#   - BLOCKED_TOKENS：token 级【精确匹配】，只拦独立成词的破坏性命令/标志；
#   - BLOCKED_PHRASES：短语级（空格连接后子串匹配），拦多 token 危险组合。
BLOCKED_TOKENS = frozenset({
    # 破坏性命令词根
    'rm', 'rmdir', 'del', 'format', 'mkfs', 'dd',
    'shutdown', 'reboot', 'chown', 'remove-item',
    # 危险标志：find 的删除/执行族、git 强推等
    '-delete', '-exec', '-execdir', '-ok',
    '-rf', '--force', '/f', '/s',
})

BLOCKED_PHRASES = (
    # fork bomb 语法（无 shell 下不执行，留作纵深防御）
    ':(){',
    # 直接写块设备
    '> /dev/sda',
    # 全权限
    'chmod 777',
    'drop database',
    'truncate table',
    # git 强删远程分支
    'push --delete',
    # Windows 递归删目录
    'rd /s',
)

# 由 Sandbox 原生实现的内建命令：完全不经过子进程/shell
NATIVE_BUILTINS = frozenset({'echo', 'pwd', 'dir', 'ls', 'type', 'cat'})

# shell 元字符（注入信号）：内建命令参数中出现即视为注入尝试，
# 恢复从严黑名单检查；纯文本参数（无元字符）直接放行。
SHELL_METACHARS = ('&&', '||', ';', '|', '>', '<', '`', '$(')

# 原生读文件的最大输出字符数（防止 cat 大文件撑爆内存）
_MAX_READ_CHARS = 100_000


class SandboxError(Exception):
    """沙盒拒绝执行或执行失败。"""


class Sandbox:
    """受限执行环境：模式开关 + 白名单命令 + 超时 + 输出捕获。

    用法：
        sb = Sandbox(config={'sandbox_timeout': 5})              # strict（默认）
        sb = Sandbox(config={'sandbox_mode': 'open'})            # 体验档
        result = sb.run('echo hello')
        # result = {'ok': True, 'stdout': 'hello', 'exit_code': 0, 'elapsed': 0.01}
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}

        # ---- 模式解析：非法值一律回落 strict（宁严勿松）----
        mode = str(self.config.get('sandbox_mode') or 'strict').strip().lower()
        self.mode = mode if mode in SANDBOX_MODES else 'strict'

        # ---- 白名单解析 ----
        # 优先级：显式 sandbox_allow 完全覆盖 > 按 mode 取内置白名单
        allow = self.config.get('sandbox_allow')
        if allow:
            self.allow = list(allow)
        elif self.mode == 'open':
            self.allow = _default_allow_open()
        else:
            self.allow = _default_allow()

        # ---- 超时归一化：配置传字符串（如 '5'）也能正常参与比较，
        # 避免 subprocess.run(timeout='5') 抛 TypeError 吞成裸异常结果 ----
        try:
            self.timeout = float(self.config.get('sandbox_timeout', 10))
        except (TypeError, ValueError):
            self.timeout = 10

        self.cwd = self.config.get('sandbox_cwd', None)

    # ---------- 权限检查 ----------
    def _parse(self, command: str) -> Optional[List[str]]:
        """解析命令为 token 列表（Windows 友好切分）；解析失败返回 None。"""
        try:
            parts = _split_cmd(command)
        except Exception:
            return None
        return parts if parts else None

    def _check_permission(self, command: str) -> bool:
        """判断命令是否在白名单内且不含被禁片段。

        白名单匹配规则：【首个 token 精确匹配】。

        原生内建命令（echo/pwd/dir/ls/type/cat）不经过子进程与 shell：
          - 参数为纯文本（无 shell 元字符）时只是数据（打印文本/读文件/
            列目录），不构成执行风险，跳过黑名单检查——否则 `echo rm`、
            `dir /s` 这类无害命令会被 token 级黑名单误伤；
          - 参数中出现 shell 元字符（&& || ; | > < 反引号 $(）时，
            视为注入信号，恢复从严黑名单检查，拦截
            `echo hi && rm -rf /tmp/x` 这类"看似文本实为注入"的组合。
        """
        if not command or not command.strip():
            return False

        parts = self._parse(command)
        if not parts:
            return False

        first = parts[0].lower()

        # 原生内建：无元字符时参数只是数据，直接放行（full 档同样放行）
        if first in NATIVE_BUILTINS:
            if self.mode == 'full':
                return True
            if first not in self.allow:
                return False
            joined_cmd = ' '.join(parts).lower()
            if any(mc in joined_cmd for mc in SHELL_METACHARS):
                # 含注入信号 → 黑名单从严
                if any(tok.lower() in BLOCKED_TOKENS for tok in parts):
                    return False
                for phrase in BLOCKED_PHRASES:
                    if phrase in joined_cmd:
                        return False
            return True

        # 外部命令：黑名单第一层 token 级精确匹配（所有模式生效，含 full 档）
        if any(tok.lower() in BLOCKED_TOKENS for tok in parts):
            return False

        # 黑名单第二层：短语级子串匹配（多 token 危险组合）
        joined = ' '.join(parts).lower()
        for phrase in BLOCKED_PHRASES:
            if phrase in joined:
                return False

        # full 档：跳过白名单检查，黑名单是唯一防线
        if self.mode == 'full':
            return True

        return first in self.allow

    # ---------- 原生内建命令 ----------
    @staticmethod
    def _result(command: str, ok: bool, stdout: str, stderr: str,
                exit_code: int, start: float) -> Dict[str, Any]:
        return {
            'ok': ok,
            'command': command,
            'stdout': stdout.strip(),
            'stderr': stderr.strip(),
            'exit_code': exit_code,
            'elapsed': round(time.time() - start, 3),
        }

    def _run_native(self, command: str, parts: List[str]) -> Dict[str, Any]:
        """原生实现内建命令：echo/pwd/dir/ls/type/cat。

        不经过任何子进程或 shell，因此不存在元字符注入问题；
        元字符（| && > 等）只会作为普通文本出现在输出中；
        跨平台（Windows/Linux/macOS）行为一致。
        """
        start = time.time()
        name = parts[0].lower()
        args = [a for a in parts[1:]]

        try:
            if name == 'echo':
                # 还原参数（切分器已去引号），用空格拼接输出
                return self._result(command, True, ' '.join(args), '', 0, start)

            if name == 'pwd':
                base = self.cwd or os.getcwd()
                return self._result(command, True, base, '', 0, start)

            if name in ('dir', 'ls'):
                # 取第一个非 flag 参数作为目标路径，默认当前目录
                target = next((a for a in args if not a.startswith('-')), '.') or '.'
                if not os.path.isabs(target):
                    target = os.path.join(self.cwd or os.getcwd(), target)
                if not os.path.exists(target):
                    return self._result(command, False, '',
                                        f'路径不存在: {target}', 1, start)
                if os.path.isfile(target):
                    entries = [os.path.basename(target)]
                else:
                    entries = sorted(os.listdir(target))
                return self._result(command, True, '\n'.join(entries), '', 0, start)

            if name in ('type', 'cat'):
                files = [a for a in args if not a.startswith('-')]
                if not files:
                    return self._result(command, False, '', '缺少文件参数', 1, start)
                chunks = []
                for fp in files:
                    if not os.path.isabs(fp):
                        fp = os.path.join(self.cwd or os.getcwd(), fp)
                    if not os.path.isfile(fp):
                        return self._result(command, False, '',
                                            f'文件不存在: {fp}', 1, start)
                    with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                        chunks.append(f.read(_MAX_READ_CHARS))
                return self._result(command, True, '\n'.join(chunks), '', 0, start)

        except OSError as e:
            return self._result(command, False, '', str(e), 1, start)

        # 理论上不会到这里（调用方保证 name 是内建命令）
        return self._result(command, False, '', f'未实现的内建命令: {name}', 2, start)

    # ---------- 外部命令 ----------
    def _resolve_executable(self, exe: str) -> Optional[str]:
        """在 PATH 中查找可执行文件；找不到返回 None（拒绝执行）。"""
        if os.path.isabs(exe) and os.path.isfile(exe):
            return exe
        return shutil.which(exe)

    # ---------- 执行 ----------
    def run(self, command: str) -> Dict[str, Any]:
        """在沙盒内执行命令，返回结构化结果。越权命令抛 SandboxError。"""
        # off 档：一切拒绝（放在最前，即使白名单非空也不执行）
        if self.mode == 'off':
            raise SandboxError(
                '沙盒已被关闭（sandbox_mode="off"）：'
                '如需执行请将 sandbox_mode 设为 "strict" 或 "open"'
            )

        if not self._check_permission(command):
            raise SandboxError(
                f"命令被沙盒拒绝（不在白名单或含禁止操作）：{command!r}"
            )

        parts = self._parse(command)
        if not parts:
            raise SandboxError(f"命令解析失败：{command!r}")

        # 内建命令走原生实现（无子进程、无 shell）
        if parts[0].lower() in NATIVE_BUILTINS:
            return self._run_native(command, parts)

        resolved = self._resolve_executable(parts[0])
        if resolved is None:
            raise SandboxError(f"命令不可用（未在系统中找到）：{command!r}")

        start = time.time()
        try:
            proc = subprocess.run(
                [resolved] + parts[1:],
                capture_output=True,
                text=True,
                timeout=self.timeout,
                cwd=self.cwd,
                shell=False,
            )
            return self._result(command, proc.returncode == 0,
                                proc.stdout, proc.stderr, proc.returncode, start)
        except subprocess.TimeoutExpired:
            return self._result(
                command, False, '', f'执行超时（>{self.timeout}s）', -1, start)
        except Exception as e:  # noqa: BLE001
            return self._result(command, False, '', str(e), -2, start)

    # ---------- 环境反馈闭环 ----------
    def feedback_block(self, results: List[Dict[str, Any]]) -> str:
        """把一批执行结果格式化成可注入上下文的反馈文本。

        供 run_discussion 在"行动 → 观察"阶段使用：把执行结果作为
        环境反馈喂回给模型，让引擎基于真实结果调整下一步。
        """
        if not results:
            return ''
        lines = ['【环境反馈（沙盒执行结果）】']
        for i, r in enumerate(results, 1):
            status = '成功' if r.get('ok') else '失败'
            lines.append(f"{i}. 命令 `{r.get('command')}` → {status} (exit={r.get('exit_code')}, {r.get('elapsed')}s)")
            if r.get('stdout'):
                lines.append(f"   输出: {r['stdout'][:500]}")
            if r.get('stderr'):
                lines.append(f"   错误: {r['stderr'][:300]}")
        return "\n".join(lines)

    def stats(self) -> Dict[str, Any]:
        return {
            'mode': self.mode,
            'allow_count': len(self.allow),
            'allow': list(self.allow),
            'native_builtins': sorted(NATIVE_BUILTINS),
            'timeout': self.timeout,
            'cwd': self.cwd,
            'shell': False,
        }
