# 模块文档：Web 前端（doc-webui）

> 覆盖：`web/`（官方 Web UI）、根目录 `platform_home.html`、`src/mobile-dist/`
> 对应代码量：~4,000 行 ｜ 更新：2026-08-29

---

## 1. 文件地图

| 文件 | 职责 | 规模 |
|------|------|------|
| web/index.html | 主界面（SPA，panel 路由） | 87.5KB |
| web/js/app.js | **全部前端逻辑** | **261KB ⚠️ 全项目最大前端文件** |
| web/js/i18n.js | 国际化（data-i18n 属性 + 字典） | 179KB |
| web/js/market.js + web/market.js | 市场页逻辑（两份 ⚠️ 待确认主从） | ~10KB×2 |
| web/index.html 87.5KB | 主界面 | — |
| web/admin.html | 管理后台 UI | 14KB |
| web/model-management.html + model-mgmt.js | 模型管理页 | 60KB |
| web/market.html | 市场独立页 | 5.7KB |
| web/css/ | style.css / market.css / mobile.css | ~24KB |
| platform_home.html（根） | 平台门户首页（已改造：功能总览+介绍弹窗+主题下拉） | 114KB |
| src/mobile-dist/lingxi-mobile.js | 移动端打包产物（9.4MB，勿手改） | — |

### ⚠️ 前端目录里的历史包袱

- `.func` 后缀文件（app.js.func / i18n.js.func / style.css.func）：疑似
  "函数提取版"快照，非运行文件，待归档
- `_cleanup-bak-20260802-*` ×4、`_rollback-0602`、`web_backup_v9/`：
  手工备份目录，git 接管后全部删除
- `index.html.FINAL-v9layout-crystal-20260802.html`：命名即历史

## 2. 主界面结构（index.html + app.js）

- **panel 路由**：panel-home（功能总览）/ 会话 / 市场 / 好友 / 群组 / 收件箱 /
  工作流 / 设置 / 多AI，靠 `display` 切换 + 侧边导航
- **6 套主题**：深海/玻璃/晨光/终端/极简/粉红，2026-08-29 起收进顶栏
  「🎨 主题 ▾」下拉菜单（_patch_theme_swap.cjs 那轮改造）
- **i18n**：元素挂 `data-i18n` 属性，i18n.js 字典替换。⚠️ 部分按钮仍写死
  中文（如"🔀 多AI"），国际化未完成——新按钮必须同时加字典条目
- 多 AI 发送：`multiAISend()` 收集勾选模型+模式 → POST /api/multi-ai →
  流式渲染 → 工具调用显示 🔧 徽章

## 3. 改前端纪律

1. **app.js 261KB 单文件**：改前先 Ctrl+F 确认函数唯一性，同名函数
   可能有多处定义（历史上出过 wallet 按钮双绑定）
2. **主题**：新增主题要同时改 CSS 变量组 + 主题下拉菜单 + i18n
3. **panel 新增**：HTML 区块 + 侧边导航按钮 + showPanel 逻辑 + i18n 四件套
4. **改完必测移动端**：mobile.css 覆盖响应式，桌面好看≠手机能用
5. platform_home.html 与 web/index.html 是两个页面，改版时别改错对象

---

## 回归测试清单（改前端必跑）

- [ ] 三主题切换正常（深海/玻璃/晨光），下拉菜单开合正常
- [ ] panel 逐个切换无白屏，功能总览卡片跳转正确
- [ ] 功能介绍弹窗：打开/关闭/去使用按钮
- [ ] 登录/注册/登出流程
- [ ] 普通对话 + 多 AI 对话（勾 2 个模型 + 切模式）
- [ ] 市场页：列表加载/发布表单/雇佣按钮
- [ ] 钱包：余额显示/充值按钮/积分明细
- [ ] i18n：切语言后无残留原文（抽查 5 个按钮）
- [ ] 手机宽度（<768px）布局不塌
- [ ] `node --check web/js/app.js` 语法通过

## 坑位记录

### 2026-08-27 钱包按钮事件双绑定
- 现象：充值按钮一次点击触发两次请求
- 根因：app.js 多处对同一按钮 addEventListener（历史补丁叠加）
- 教训：**改前端事件绑定前先 grep 同一 id 的绑定次数**，修复轮次多了以后
  这是最容易复发的坑

### 2026-08-29（建档）.func 文件来源不明
- app.js.func / i18n.js.func / style.css.func / mobile.css.func 与正式文件
  并存，大小接近但不同。任何"清理"动作前先确认没有页面引用它们