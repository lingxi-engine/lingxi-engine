# 模块文档：工具系统与渠道接入（doc-tools-channels）

> 覆盖：`src/tools/`、`src/channels/`、`src/mcp/`、`src/skills/`
> 对应代码量：~6,000 行 ｜ 更新：2026-08-29

---

## 1. 工具系统（src/tools/）

| 文件 | 职责 | 规模 |
|------|------|------|
| builtin.ts | **所有内置工具注册**（BUILTIN_TOOLS + BUILTIN_SKILLS） | **95KB ⚠️ 最大文件** |
| registry.ts | ToolRegistry：注册/查询/execute 白名单执行 | 6.5KB |
| executor.ts | 工具执行器 | 23.8KB |
| browser.ts | BrowserManager（Puppeteer 可选依赖） | 11.3KB |
| search-providers.ts | 搜索源管理（与 core/ 有双胞胎 ⚠️） | 13.6KB |
| office-reader.ts | Office/PDF 文件读取 | 10.9KB |
| auto-skill.ts | 自动技能生成 | 5.3KB |
| types.ts | 工具类型定义 | 4.7KB |

### 工具调用规则

- AI 只能调用 registry 里注册过的工具（白名单），未注册 capability 直接拒绝
- `setSearchManager()` 由主入口注入搜索能力——**改搜索先确认 import 的是
  tools 版还是 core 版**（双胞胎陷阱）
- 工具结果在多 AI 链路中截断 4000 字符回填（见 doc-chat.md）
- 写操作类工具必须接 approval.ts 审批流

### builtin.ts 拆分计划（95KB，全项目第一大文件）

按工具类别拆：file-tools / web-tools / code-tools / media-tools / system-tools，
每个文件导出工具数组，builtin.ts 只做聚合导出。拆完每步跑 typecheck + 工具冒烟。

## 2. 渠道接入（src/channels/，10 个）

| 渠道 | 文件 | 说明 |
|------|------|------|
| Telegram | telegram.ts (6.9KB) | 最常用，改动后重点测 |
| 微信 | wechat.ts (5.9KB) | 协议易碎，改动谨慎 |
| Discord | discord.ts (6KB) | |
| QQ 机器人 | qqbot.ts (5.8KB) | |
| 飞书 | feishu.ts (4.7KB) | |
| Slack | slack.ts (3.8KB) | |
| Signal | signal.ts (5KB) | |
| WhatsApp | whatsapp.ts (3.4KB) | |
| iMessage | imessage.ts (2.3KB) | 仅 macOS |
| manager.ts (9.7KB) | 渠道管理器：统一注册/启停/消息入口 | |

- 渠道消息统一汇入主消息链路（processUserMessage），与 WS 聊天同源
- 新增渠道：实现与 manager.ts 对接的适配器，注册进 manager 即可

## 3. MCP 与技能

- `src/mcp/adapter.ts`：MCP 协议适配（外部工具接入）
- `src/skills/`：60+ 个技能 JSON（bug 修复/部署/诊断类）+ skill-manager.ts
  + 两个 SKILL.md 技能包（email-checker / weather-briefing）
- 技能 JSON 是工具的"配方"，改工具签名时检查引用它的技能 JSON

---

## 回归测试清单（改工具/渠道必跑）

- [ ] 工具白名单：未注册工具被拒，已注册工具正常执行
- [ ] 搜索工具：至少一个搜索源可用，结果回填对话
- [ ] office-reader：读 docx/pdf/xlsx 各一次
- [ ] 浏览器工具：puppeteer 未安装时优雅降级（optionalDependencies）
- [ ] Telegram 渠道：发消息 → 引擎回复
- [ ] 渠道管理器：启停一个渠道不影响其他渠道
- [ ] 技能 JSON：任选 3 个技能能被正确加载
- [ ] `npm run typecheck` 绿

## 坑位记录

### 2026-08-29（建档）puppeteer 是可选依赖
- package.json 里 puppeteer 在 optionalDependencies，装不上（网络/系统缺库）
  时浏览器工具必须优雅降级，不能让引擎起不来
- 教训：**任何新增的重量级可选依赖都要走同样的降级模式**