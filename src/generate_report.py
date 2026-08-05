#!/usr/bin/env python3
"""生成灵犀引擎 Bug 审计 + 屎山审计 + 重构报告 Word 文档"""

from docx import Document
from docx.shared import Inches, Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
import os

doc = Document()

# ── 全局样式 ──
style = doc.styles['Normal']
style.font.name = '微软雅黑'
style.font.size = Pt(11)
style.element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
style.paragraph_format.space_after = Pt(6)
style.paragraph_format.line_spacing = 1.15

# ── 辅助函数 ──
def add_heading(text, level=1, color=None):
    h = doc.add_heading(text, level=level)
    for run in h.runs:
        run.font.name = '微软雅黑'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
        if color:
            run.font.color.rgb = color
    return h

def add_para(text, bold=False, color=None, size=None):
    p = doc.add_paragraph()
    run = p.add_run(text)
    run.font.name = '微软雅黑'
    run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    if bold: run.bold = True
    if color: run.font.color.rgb = color
    if size: run.font.size = Pt(size)
    return p

def add_code(text):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Cm(1)
    run = p.add_run(text)
    run.font.name = 'Consolas'
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
    return p

def add_table(headers, rows):
    table = doc.add_table(rows=1+len(rows), cols=len(headers))
    table.style = 'Light Grid Accent 1'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = h
        for p in cell.paragraphs:
            for run in p.runs:
                run.bold = True
                run.font.size = Pt(10)
    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            table.rows[r+1].cells[c].text = str(val)
    return table

def add_separator():
    p = doc.add_paragraph()
    p.add_run('─' * 50).font.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)

# ═══════════════════════════════════════════════════
# 封面
# ═══════════════════════════════════════════════════
title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run('\n\n灵犀引擎\n')
run.font.name = '微软雅黑'
run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
run.font.size = Pt(36)
run.bold = True
run.font.color.rgb = RGBColor(0x1a, 0x73, 0xe8)

subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = subtitle.add_run('Bug 审计 · 屎山审计 · 重构报告\n')
run.font.name = '微软雅黑'
run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
run.font.size = Pt(20)
run.font.color.rgb = RGBColor(0x5f, 0x63, 0x68)

date_p = doc.add_paragraph()
date_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = date_p.add_run('\n2026年7月23日\n')
run.font.name = '微软雅黑'
run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
run.font.size = Pt(14)
run.font.color.rgb = RGBColor(0x5f, 0x63, 0x68)

doc.add_page_break()

# ═══════════════════════════════════════════════════
# 目录
# ═══════════════════════════════════════════════════
add_heading('目录', level=1)
add_para('一、Bug 审计报告（20 个 Bug）')
add_para('二、屎山审计报告（18 个屎山）')
add_para('三、重构报告')
add_para('四、遗留问题与后续建议')
doc.add_page_break()

# ═══════════════════════════════════════════════════
# 一、Bug 审计报告
# ═══════════════════════════════════════════════════
add_heading('一、Bug 审计报告', level=1)
add_para('共发现 20 个 Bug，按严重级别分为 P0（严重）、P1（高）、P2（中）、P3（低）四级。', bold=True)

# ── 汇总表 ──
add_heading('汇总', level=2)
add_table(
    ['严重级别', '数量', '关键问题'],
    [
        ['P0 严重', '3', '登录失效、类型安全绕过、自动保存频率错误'],
        ['P1 高', '5', 'RBAC 权限绕过、DB 方法调用错误、模型路由错误、Ollama 无条件注册、Docker 重复检测'],
        ['P2 中', '7', '计算器函数失效、压缩丢上下文、链式模式失效、SQL 参数错位、任务完成误判、流式重复、路由半成品'],
        ['P3 低', '5', '遗留代码、不兼容 API、沙箱逃逸、Provider 名称硬编码、Docker 只读矛盾'],
    ]
)

# ── P0 ──
add_heading('P0 — 严重 Bug（可导致崩溃/安全漏洞）', level=2)

add_heading('Bug #1: loginWithEmail 是 async 但路由层当同步调用', level=3)
add_para('文件: src/auth/index.ts 第 158 行 vs src/core/index.ts 路由层', bold=True)
add_para('loginWithEmail 声明为 async 返回 Promise，但路由层调用时没有 await，直接展开 result 对象。展开 Promise 对象不会得到 accessToken 和 user 字段，导致邮箱登录返回空响应，用户无法通过邮箱登录。', color=RGBColor(0xD9, 0x30, 0x25))
add_para('修复状态: ✅ 已修复 — 路由层加 await', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #2: ApprovalManager.waitForApproval 构造的 fallback 对象缺少必需字段', level=3)
add_para('文件: src/core/approval.ts 第 113 行', bold=True)
add_para('waitForApproval 的 fallback 对象缺少 agentId、action、risk 等必需字段，用 as unknown as 强转绕过类型检查。如果有代码依赖这些字段，运行时会得到 undefined。')
add_para('修复状态: ✅ 已修复 — fallback 对象补全所有必需字段', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #3: startAutoSave 注释说"每30秒"但实际传了 5000ms（5秒）', level=3)
add_para('文件: src/core/index.ts 第 131 行', bold=True)
add_para('注释说 30 秒，实际是 5 秒。5 秒一次的磁盘写入对 sql.js（内存数据库导出整个文件）性能有影响。')
add_para('修复状态: ✅ 已修复 — startAutoSave(30000)', color=RGBColor(0x1e, 0x8e, 0x3e))

# ── P1 ──
add_heading('P1 — 高优先级 Bug', level=2)

add_heading('Bug #4: rbac 函数使用 req.user?.id 但 JWT payload 的字段是 sub', level=3)
add_para('文件: src/core/index.ts 第 76 行', bold=True)
add_para('JWT payload 结构是 { sub, numeric_id, sid }，没有 id 字段。req.user?.id 永远是 undefined，RBAC 权限检查总是 fallback 到 query/body 参数——任何用户只要在 URL 或 body 里传 userId 就能绕过权限。', color=RGBColor(0xD9, 0x30, 0x25))
add_para('修复状态: ✅ 已修复 — 使用 req.user?.sub', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #5: getParticipantRole 调用 d.listParticipants 但 DB 实例没有这个方法', level=3)
add_para('文件: src/core/index.ts 第 72 行', bold=True)
add_para('getDB() 返回的是底层 sql.js Database 实例，没有 listParticipants 方法。应该用 db.ts 的 getChatParticipants 函数。RBAC 中间件一旦被调用就会抛异常返回 500。')
add_para('修复状态: ✅ 已修复 — 使用 getChatParticipants()', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #6: AIHub.getClient 模糊匹配可能把模型路由到错误的 Provider', level=3)
add_para('文件: src/ai/hub.ts getClient 方法', bold=True)
add_para('当 NVIDIA NIM 和 DeepSeek 都有 deepseek-v4-flash 相关模型时，模糊匹配 model.includes(m) || m.includes(model) 可能优先匹配到 NVIDIA NIM（Map 排序靠前），导致用无效的 NVIDIA API Key 发送请求，返回 401。')
add_para('修复状态: ✅ 已修复 — stripped 匹配避免前缀干扰', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #7: ProviderRegistry.registerFromEnv 无条件注册 Ollama', level=3)
add_para('文件: src/ai/provider-registry.ts 第 174 行', bold=True)
add_para('不像其他 provider 有 if (process.env.XXX_API_KEY) 守卫，Ollama 无条件注册。虽然 models 为空不会匹配到，但 getDefaultModel 的 fallback 逻辑会尝试它。')
add_para('修复状态: ✅ 已修复 — 只在显式配置时注册', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #8: docker-sandbox.ts 中 detectDocker() 被调用两次', level=3)
add_para('文件: src/core/docker-sandbox.ts', bold=True)
add_para('detectDocker() 直接调用 execSync("docker info")，没有缓存。模块加载时被调用两次，每次都 spawn 一个子进程。')
add_para('修复状态: ✅ 已修复 — 统一使用 dockerReallyAvailable() 缓存', color=RGBColor(0x1e, 0x8e, 0x3e))

# ── P2 ──
add_heading('P2 — 中等优先级 Bug', level=2)

add_heading('Bug #9: builtin.ts 中 Docker 动态导入可能未加载完成就被使用', level=3)
add_para('文件: src/core/builtin.ts 第 15-24 行', bold=True)
add_para('异步导入 docker-sandbox 模块，dockerAvailable 和函数指针在 Promise resolve 后才设置。如果服务器刚启动就有工具调用请求，Docker 沙箱可能还没初始化完成。')
add_para('修复状态: ✅ 已修复 — 添加 dockerReady Promise 和 ensureDockerReady()', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #10: calculate 工具的正则过滤逻辑有缺陷', level=3)
add_para('文件: src/core/builtin.ts handleCalculate', bold=True)
add_para('三步 replace 逻辑混乱：第一步删掉所有字母（包括函数名），第二步又"保留"函数名但已被删除，第三步又允许字母通过。sin(1) 会变成 (1) 而不是 Math.sin(1)。')
add_para('修复状态: ✅ 已修复 — 正则重写，使用白名单函数映射', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #11: compaction.ts 压缩时丢失 tool_calls 和 tool_call_id 信息', level=3)
add_para('文件: src/core/compaction.ts compactMessages', bold=True)
add_para('只取 content 字段，丢弃了 tool_calls、tool_call_id、name 等字段。压缩后上下文完全丢失工具调用链。')
add_para('修复状态: ✅ 已修复 — formatMessage() 保留 tool_calls 信息', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #12: ws-handler.ts 中 agent.task 的自主循环判断"任务完成"过于简单', level=3)
add_para('文件: src/core/ws-handler.ts 第 89 行', bold=True)
add_para('AI 回复中只要包含"任务完成"或"DONE"就停止，但 AI 可能在讨论中提到这些词而非真正完成任务。')
add_para('修复状态: ✅ 已修复 — isTaskComplete() 只检查最后 3 行，且要求行首匹配', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #13: router.ts 中流式输出在工具调用后重复发送内容', level=3)
add_para('文件: src/core/router.ts generateReply', bold=True)
add_para('经验证非 Bug：runToolsLoop 内部不通过 onChunk 发送内容，不会重复。')

add_heading('Bug #14: db.ts 中 updateAgent 函数的 SQL 参数传递方式不一致', level=3)
add_para('文件: src/storage/db.ts', bold=True)
add_para('使用 spread ...vals 传参，但 sql.js 的 run 方法接受数组参数。当有多个字段更新时，SQL 参数绑定会错位。')
add_para('修复状态: ✅ 已修复 — 用数组传递 vals', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #15: chat-modes.ts 中 dispatchChain 的 needsFollowUp 未设置', level=3)
add_para('文件: src/core/chat-modes.ts', bold=True)
add_para('没有设置 needsFollowUp: true，而 ws-handler.ts 检查的是 result.needsFollowUp。链式模式永远不会触发后续轮次。')
add_para('修复状态: ✅ 已修复 — dispatchChain 设置 needsFollowUp: true', color=RGBColor(0x1e, 0x8e, 0x3e))

# ── P3 ──
add_heading('P3 — 低优先级/代码质量问题', level=2)

add_heading('Bug #16: hub.ts 中 listProviders 的 name 硬编码了部分 provider 名称', level=3)
add_para('修复状态: ✅ 已修复 — 添加 PROVIDER_NAMES 映射表', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #17: index.ts 中 verificationCodes Map 定义了但从未使用', level=3)
add_para('V7 认证改用了 user_verifications 表，这个 Map 是遗留代码。')
add_para('修复状态: ✅ 已修复 — 移到 auth.ts 路由内（旧版兼容用）', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #18: hub.ts 中 Anthropic 的 baseUrl 不兼容 OpenAI SDK', level=3)
add_para('Anthropic API 不是 OpenAI 兼容的，用 OpenAI SDK 直接调用会失败。')
add_para('修复状态: ⚠️ 已标注 — 需要适配层实现（后续处理）', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('Bug #19: builtin.ts 中 safePath 在沙箱关闭时允许绝对路径逃逸', level=3)
add_para('沙箱关闭时，read_file("/etc/passwd") 或 write_file("C:\\\\Windows\\\\system32\\\\evil.bat") 不会被阻止。')
add_para('修复状态: ✅ 已修复 — 沙箱关闭时也阻止敏感路径', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('Bug #20: docker-sandbox.ts 中 --read-only 可能导致某些工具执行失败', level=3)
add_para('--read-only 使整个文件系统只读，只有 /tmp 可写。但 runJsInDocker 把代码挂载到 /sandbox/ 下也是只读的，node 执行时可能需要写临时文件到 cwd。')
add_para('修复状态: ✅ 已修复 — 去掉 --read-only，改用 tmpfs /sandbox 可写', color=RGBColor(0x1e, 0x8e, 0x3e))

doc.add_page_break()

# ═══════════════════════════════════════════════════
# 二、屎山审计报告
# ═══════════════════════════════════════════════════
add_heading('二、屎山审计报告', level=1)
add_para('共发现 18 个屎山，按严重程度分为超级（⭐⭐⭐⭐⭐）、大型（⭐⭐⭐⭐）、中型（⭐⭐⭐）、小型（⭐⭐）四级。', bold=True)

add_heading('汇总', level=2)
add_table(
    ['屎山级别', '数量', '核心问题'],
    [
        ['⭐⭐⭐⭐⭐ 超级', '2', 'God File 115KB、双胞胎文件 84KB+54KB'],
        ['⭐⭐⭐⭐ 大型', '4', '40+ Provider 硬编码、职责重叠、40KB DB 层、37KB 路由层'],
        ['⭐⭐⭐ 中型', '7', '全局状态、any 滥用、正则地狱、压缩丢上下文、路由半成品、命令注入、HTML 正则'],
        ['⭐⭐ 小型', '5', '代码重复、心跳不更新、RAG 玩具向量、Docker 只读矛盾、审批代码重复'],
    ]
)

# ── 超级屎山 ──
add_heading('超级屎山（God File / 代码堆积）', level=2)

add_heading('屎山 #1: index.ts — 115KB 的上帝文件', level=3)
add_para('两个入口文件 index.ts (115KB) 和 src/core/index.ts (102KB) 几乎完全重复，且都是巨型 God File。一个文件里包含 Express 路由、WebSocket 处理、RBAC 权限、用户注册/登录、Agent CRUD、群聊管理、文件上传、Channel 适配器、Cron 调度器、MCP 管理器、Provider 管理、模型管理、沙箱管理、Skill 管理、调试面板等几十个功能模块。')
add_para('重构状态: ✅ 已拆分 — index.ts 从 115KB 缩减到 22KB，按功能拆分为 15 个路由模块', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('屎山 #2: builtin.ts 双胞胎 — 84KB + 55KB', level=3)
add_para('src/tools/builtin.ts (84KB) 和 src/core/builtin.ts (55KB) 几乎相同，但两个文件都被 import。safePath 逻辑重复但实现不同（新版有敏感路径黑名单，旧版没有）。')
add_para('重构状态: ⚠️ 待处理 — 需删除 src/core/builtin.ts 并清理引用', color=RGBColor(0xe8, 0x71, 0x0a))

# ── 大型屎山 ──
add_heading('大型屎山（架构问题）', level=2)

add_heading('屎山 #3: hub.ts — 40+ 个 AI Provider 全部硬编码', level=3)
add_para('DEFAULT_PROVIDERS 数组硬编码了 20+ 个 Provider 的完整配置，全部在模块顶层执行。每次启动都会创建 20+ 个 OpenAI SDK 实例（即使没配 Key）。与 provider-registry.ts 功能重叠。')
add_para('重构状态: ⚠️ 待处理 — 需合并 hub.ts 和 provider-registry.ts', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #4: hub.ts 和 provider-registry.ts 职责重叠', level=3)
add_para('两个文件都管理 AI Provider，匹配策略不同。index.ts 同时初始化两个，但路由层只用 AIHub。Map 中可能冲突。')
add_para('重构状态: ⚠️ 待处理', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #5: db.ts — 40KB 的全功能数据库层', level=3)
add_para('一个文件包含 15+ 张表的 DDL、用户/Agent/群聊/消息/参与者/邀请码/验证 token/RAG/记忆/好友/Inbox/Chat mode 全部 CRUD。函数命名混乱。')
add_para('重构状态: ⚠️ 建议后续拆分', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #6: router.ts — 37KB 的消息路由层', level=3)
add_para('MessageRouter 类承担了消息入站、Agent 回复决策、AI 回复生成、工具调用循环、记忆反思、RAG 检索、上下文压缩、自动技能创建等过多职责。')
add_para('重构状态: ⚠️ 建议后续拆分', color=RGBColor(0xe8, 0x71, 0x0a))

# ── 中型屎山 ──
add_heading('中型屎山（代码质量问题）', level=2)

add_heading('屎山 #7: 全局变量满天飞', level=3)
add_para('模块级 let 变量充当全局状态，没有封装。searchManager 在 builtin.ts 和 index.ts 各 new 了一次——双实例问题。')
add_para('重构状态: ✅ 已修复 — ServerContext 统一管理，setSearchManager 注入', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('屎山 #8: any 类型滥用', level=3)
add_para('整个项目充斥 any 类型。chat-modes.ts 的 dispatchByMode 参数全是 any，完全没有类型安全。')
add_para('重构状态: ⚠️ 建议后续逐步替换为具体类型', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #9: executor.ts 的工具调用解析——正则地狱', level=3)
add_para('4 层正则匹配策略极其脆弱，嵌套 JSON 会匹配失败。应该用 OpenAI 的原生 tool_calls 字段。')
add_para('重构状态: ⚠️ 建议后续重构', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #10: search-providers.ts 的 HTML 解析用正则', level=3)
add_para('用正则解析 HTML 是经典反模式。Bing 或 DDG 改版面就直接挂。')
add_para('重构状态: ⚠️ 免依赖的兜底方案，暂可接受', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #11: 重复的 shouldAgentRespond 逻辑', level=3)
add_para('同一个函数在 router.ts、chat-modes.ts、index.ts 三处重复实现。')
add_para('重构状态: ⚠️ 待统一', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #12: approval.ts 的 approve/reject/expire 代码重复', level=3)
add_para('三个方法的代码结构几乎一致，应该抽一个 private resolve(id, status, by?, reason?) 方法。')
add_para('重构状态: ⚠️ 建议后续优化', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #13: hooks.ts 的命令注入风险', level=3)
add_para('{message} 的值来自用户输入，替换后 cmd.split(/\\s+/) 会把消息中的空格拆成多个参数。转义不完整。')
add_para('重构状态: ⚠️ 建议后续修复', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #14: docker-sandbox.ts 的 --read-only + 挂载矛盾', level=3)
add_para('容器文件系统只读，/tmp 可写但 noexec，挂载的代码文件也是只读。node 执行时如果需要写临时文件到 cwd 会失败。')
add_para('重构状态: ✅ 已修复 — 去掉 --read-only，改用 tmpfs /sandbox 可写', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('屎山 #15: compaction.ts 压缩时丢弃工具调用链', level=3)
add_para('只取 content，完全丢弃 tool_calls、tool_call_id、name。')
add_para('重构状态: ✅ 已修复 — formatMessage() 保留工具调用信息', color=RGBColor(0x1e, 0x8e, 0x3e))

add_heading('屎山 #16: chat-modes.ts 的 dispatchRoute 是半成品', level=3)
add_para('没有真正做路由分析——只是让路由 Agent 回复，然后让所有 full 模式的 Agent 也回复。这不是"路由"，这是"广播"。')
add_para('重构状态: ⚠️ 功能性问题，建议后续完善', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #17: instance-mesh.ts 的心跳不更新 agent 列表', level=3)
add_para('agents 参数在启动时传入，之后即使新增/删除了 Agent，心跳发送的还是旧列表。')
add_para('重构状态: ⚠️ 建议后续修复', color=RGBColor(0xe8, 0x71, 0x0a))

add_heading('屎山 #18: rag-engine.ts 的 hash 向量化是玩具级', level=3)
add_para('128 维的 hash 向量化，碰撞率极高。默认关闭 useEmbeddingAPI，RAG 检索质量很差。')
add_para('重构状态: ⚠️ 建议后续启用真正的 embedding API', color=RGBColor(0xe8, 0x71, 0x0a))

doc.add_page_break()

# ═══════════════════════════════════════════════════
# 三、重构报告
# ═══════════════════════════════════════════════════
add_heading('三、重构报告', level=1)

add_heading('重构目标', level=2)
add_para('将 115KB 的 God File (index.ts) 拆分为模块化的路由文件，确保功能正常，不引入新的 bug。')

add_heading('创建的新文件（15 个）', level=2)
add_table(
    ['文件', '大小', '功能'],
    [
        ['src/server/context.ts', '2.6KB', 'ServerContext 接口 — 统一共享服务上下文'],
        ['src/server/rbac.ts', '1.7KB', 'RBAC 中间件 — 修复 Bug #4, #5'],
        ['src/routes/auth.ts', '8.4KB', '认证路由 — 修复 Bug #1 (loginWithEmail await)'],
        ['src/routes/agent.ts', '2.9KB', 'Agent CRUD 路由'],
        ['src/routes/chat.ts', '5.9KB', '聊天/参与者/消息路由'],
        ['src/routes/system.ts', '2.8KB', '系统/健康检查/版本/用量路由'],
        ['src/routes/provider.ts', '5.4KB', 'Provider 管理路由'],
        ['src/routes/market.ts', '2.4KB', 'AI 员工市场路由'],
        ['src/routes/rag.ts', '2.6KB', 'RAG 知识库路由'],
        ['src/routes/workflow.ts', '2.9KB', '工作流编排路由'],
        ['src/routes/upload.ts', '1.2KB', '文件上传路由'],
        ['src/routes/friends.ts', '2.8KB', '好友系统路由'],
        ['src/routes/admin.ts', '24.9KB', '管理路由（Cron/会话/子代理/收件箱/审批/Hook/技能/MCP/插件/语音/视觉/推送/积分/评价）'],
        ['src/routes/channel.ts', '10.9KB', '渠道管理 + Webhook + 适配器启动'],
        ['src/routes/misc.ts', '10.8KB', '联邦通信/Mesh/标签/时间/工作区模式/群聊模式'],
    ]
)

add_heading('重写的文件', level=2)
add_table(
    ['文件', '重构前', '重构后', '缩减比例'],
    [
        ['index.ts', '115KB (2538行)', '22KB (~400行)', '80.8%'],
    ]
)

add_heading('同时修复的 Bug', level=2)
add_para('1. Bug #1 (P0): loginWithEmail 缺 await → 邮箱登录失效 ✅')
add_para('2. Bug #3: startAutoSave(5000) → startAutoSave(30000) ✅')
add_para('3. Bug #4 (P1): RBAC 用 req.user?.id → req.user?.sub ✅')
add_para('4. Bug #5 (P1): d.listParticipants() → getChatParticipants() ✅')
add_para('5. Bug #17: verificationCodes 不再全局 ✅')

add_heading('架构改进', level=2)
add_para('1. ServerContext 接口：所有路由模块通过统一的上下文访问共享的管理器实例，避免全局变量 (globalThis.__xxx) 滥用。')
add_para('2. 路由模块化：按功能拆分为 15 个独立路由文件，每个文件职责单一，修改某个功能只需改对应文件。')
add_para('3. RBAC 独立中间件：从 index.ts 抽出为 src/server/rbac.ts，修复了 JWT 字段和 DB 方法调用两个 P1 bug。')
add_para('4. 渠道适配器启动逻辑独立：startChannelAdapter() 从 index.ts 抽出为 channel.ts 的导出函数。')
add_para('5. Mesh 设置独立：setupMesh() 和 createMeshRoutes() 从 index.ts 抽出为 misc.ts 的导出函数。')

doc.add_page_break()

# ═══════════════════════════════════════════════════
# 四、遗留问题与后续建议
# ═══════════════════════════════════════════════════
add_heading('四、遗留问题与后续建议', level=1)

add_heading('需要立即处理的遗留问题', level=2)

add_para('1. 删除 src/core/index.ts (102KB 重复文件)', bold=True, color=RGBColor(0xD9, 0x30, 0x25))
add_para('   该文件是旧版入口，与新 index.ts 内容几乎一致但有微妙差异。需确认没有其他文件 import 它，然后删除。')

add_para('2. 删除 src/core/builtin.ts (55KB 重复文件)', bold=True, color=RGBColor(0xD9, 0x30, 0x25))
add_para('   该文件是旧版工具系统，与 src/tools/builtin.ts 重复。需检查所有 import 引用，清理后删除。')

add_para('3. 清理临时文件', bold=True, color=RGBColor(0xD9, 0x30, 0x25))
add_para('   _extract.js、_extract.mjs、_extract2.mjs、_extract3.mjs 是重构过程中使用的临时脚本，应删除。')

add_heading('建议后续处理的问题', level=2)

add_para('优先级 1（架构层面）:', bold=True)
add_para('• 合并 hub.ts 和 provider-registry.ts — 统一 Provider 管理，去掉硬编码的 40+ Provider')
add_para('• 拆分 db.ts (40KB) — 按功能拆为 users.ts、agents.ts、chats.ts、messages.ts、rag.ts 等')
add_para('• 拆分 router.ts (37KB) — 分离消息处理、工具调用、记忆管理、RAG 检索等职责')

add_para('优先级 2（代码质量）:', bold=True)
add_para('• 统一 shouldAgentRespond 逻辑 — 三处重复实现合并为一处')
add_para('• 重构 executor.ts 的工具调用解析 — 用 OpenAI 原生 tool_calls 字段替代正则解析')
add_para('• 逐步替换 any 类型 — 特别是 chat-modes.ts 的 dispatchByMode 参数')
add_para('• 修复 hooks.ts 命令注入风险 — 完善用户输入转义')
add_para('• 修复 instance-mesh.ts 心跳不更新 agent 列表 — 改为动态获取')
add_para('• 启用 RAG embedding API — 替换 hash 向量化')

add_para('优先级 3（功能完善）:', bold=True)
add_para('• 完善 dispatchRoute 路由分析 — 真正实现路由而非广播')
add_para('• 实现 Anthropic API 适配层 — 兼容 OpenAI SDK 调用')
add_para('• 抽取 approval.ts 的 resolve 公共方法 — 消除 approve/reject/expire 代码重复')

add_heading('修复统计', level=2)
add_table(
    ['类别', '发现总数', '已修复', '待处理'],
    [
        ['Bug', '20', '17', '3（Bug #13 非bug, #18 待适配, #13 已验证）'],
        ['屎山', '18', '5', '13'],
        ['重构', '1 (index.ts)', '1', '0'],
    ]
)

add_separator()
add_para('\n报告生成时间: 2026年7月23日', color=RGBColor(0x99, 0x99, 0x99))
add_para('审计工具: 灵犀引擎 AI 助手 (glm-5.2:cloud)', color=RGBColor(0x99, 0x99, 0x99))

# ── 保存 ──
output_path = r'C:\Users\Administrator\Desktop\灵犀引擎-Bug审计与重构报告-2026.7.23.docx'
doc.save(output_path)
print(f'报告已保存到: {output_path}')