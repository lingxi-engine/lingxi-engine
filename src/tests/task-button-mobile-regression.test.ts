/**
 * v2.0.36 / v2.0.37 回归测试：右下角「任务」按钮在移动端点不动
 *
 * 背景：
 *   v2.0.35 修过一次桌面端的问题（.show 类在桌面端无 CSS），但移动端
 *   （≤900px）仍然完全点不动。根因是多处布局冲突叠加：
 *     1) mobile.css 的 `.content-panel{position:absolute;inset:0}` 在窄屏生效，
 *        但 index.html 的 `.main-area{position:static !important}` 覆盖块把
 *        包含块打回 body，导致 #panel-chat 撑满整个视口；
 *     2) 于是 .input-area 被挤到视口底部，与 .bottom-toolbar 垂直重叠，
 *        #input textarea 正好盖住 #tbTasksBtn → 点击落到 textarea 上；
 *     3) .rightbar 被强制成 position:static，成为 in-flow flex 兄弟节点，
 *        反而盖在工具栏上；
 *     4) toggleRightbar() 只看 `rb-hidden` 类判断状态，而移动端抽屉初始
 *        是靠 transform 滑出屏外（没有 rb-hidden 类），导致首次点击算成"关闭"；
 *     5) v2.0.37：--bottom-h=40px < 按钮 min-height:44px，#tbTasksBtn
 *        底部溢出视口（iPhone SE 实测 y=626..670 > 667），按钮不在视口内。
 *
 * 修复：
 *   - 窄屏恢复 .content 的定位上下文，#panel-chat 用 bottom:var(--bottom-h)
 *     显式内缩，不再伸进工具栏区；
 *   - .main-area 用 margin-top 占用顶栏高度（relative 下 top 只是视觉位移，
 *     不占布局空间）；
 *   - .rightbar / .sidebar 在窄屏恢复为 absolute 抽屉；
 *   - toggleRightbar() 改为按"实际渲染可见性"判断当前状态；
 *   - v2.0.37：窄屏 --bottom-h 提到 48px，隐藏 .tb-status 消除横向溢出，
 *     工具栏按钮固定 44px 且 #tbTasksBtn 用 margin-left:auto 固定到右下角。
 *
 * 本测试用静态断言检查 CSS/JS 是否包含修复所需的规则（不依赖浏览器），
 * 浏览器端行为由 workspace/test-task-btn-regression.cjs 做 e2e 验证。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGETS = [
  join(ROOT, 'web', 'index.html'),
  join(ROOT, 'web', 'chat', 'index.html'),
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('v2.0.36/v2.0.37 移动端右下角任务按钮修复', () => {
  for (const file of TARGETS) {
    const label = file.replace(ROOT, '.').replace(/\\/g, '/');

    describe(label, () => {
      it('文件存在', () => {
        expect(existsSync(file)).toBe(true);
      });

      it('窄屏下 .content-panel 显式内缩 bottom:var(--bottom-h)，不再伸进工具栏', () => {
        const html = read(file);
        expect(html).toMatch(
          /\.content-panel\s*\{[^}]*bottom:\s*var\(--bottom-h\)\s*!important/s,
        );
      });

      it('窄屏下 .main-area 用 margin-top 占用顶栏高度（relative 下 top 不占空间）', () => {
        const html = read(file);
        expect(html).toMatch(/\.main-area\s*\{[^}]*margin-top:/s);
        expect(html).toMatch(/\.main-area\s*\{[^}]*top:\s*auto\s*!important/s);
      });

      it('窄屏下 .rightbar 是 absolute 抽屉，默认滑出屏外', () => {
        const html = read(file);
        expect(html).toMatch(
          /\.rightbar\s*\{[^}]*position:\s*absolute\s*!important[^}]*transform:\s*translateX\(100%\)\s*!important/s,
        );
        expect(html).toMatch(/\.rightbar\.show\s*\{\s*transform:\s*translateX\(0\)\s*!important/);
      });

      it('窄屏下 .bottom-toolbar 提升层级，保证永远可点', () => {
        const html = read(file);
        expect(html).toMatch(/\.bottom-toolbar\s*\{[^}]*z-index:\s*60\s*!important/s);
      });

      it('toggleRightbar() 按实际渲染可见性判断状态，而不是只看 rb-hidden 类', () => {
        const html = read(file);
        const fn = html.match(/function toggleRightbar\(force\)\s*\{[\s\S]*?\n\}/);
        expect(fn).not.toBeNull();
        const body = fn![0];
        expect(body).toContain('currentlyVisible');
        expect(body).toContain('getComputedStyle');
        expect(body).toContain('getBoundingClientRect');
        // 旧的脆弱判断不应再出现
        expect(body).not.toMatch(/force\s*:\s*rb\.classList\.contains\('rb-hidden'\)/);
      });

      it('按钮本身仍绑定 toggleRightbar() 且带 id（属性顺序无关）', () => {
        const html = read(file);
        // 用前瞻断言，避免依赖 id / onclick 的书写顺序
        expect(html).toMatch(
          /<button(?=[^>]*\bid="tbTasksBtn")(?=[^>]*\bonclick="toggleRightbar\(\)")[^>]*>/,
        );
      });

      it('保留 v2.0.35 的 rb-hidden 隐藏规则', () => {
        const html = read(file);
        expect(html).toMatch(/\.rightbar\.rb-hidden\s*\{\s*display:\s*none\s*!important/);
      });

      // ── v2.0.37：按钮超出视口底部 ──────────────────────────────
      it('v2.0.37: 窄屏 --bottom-h 提到 48px，容得下 44px 触控按钮', () => {
        const html = read(file);
        expect(html).toMatch(/--bottom-h:\s*48px\s*!important/);
      });

      it('v2.0.37: 窄屏工具栏按钮固定 44px 且不被压缩', () => {
        const html = read(file);
        expect(html).toMatch(
          /\.bottom-toolbar button\s*\{[^}]*height:\s*44px\s*!important[^}]*min-height:\s*44px\s*!important/s,
        );
        expect(html).toMatch(/\.bottom-toolbar button\s*\{[^}]*flex-shrink:\s*0\s*!important/s);
      });

      it('v2.0.37: 窄屏隐藏 .tb-status 并关闭横向滚动，消除溢出', () => {
        const html = read(file);
        expect(html).toMatch(/\.bottom-toolbar \.tb-status\s*\{\s*display:\s*none\s*!important/);
        expect(html).toMatch(
          /\.bottom-toolbar\s*\{[^}]*overflow-x:\s*hidden\s*!important[^}]*overflow-y:\s*hidden\s*!important/s,
        );
      });

      it('v2.0.37: 「任务」按钮用 margin-left:auto 固定到右下角', () => {
        const html = read(file);
        expect(html).toMatch(
          /\.bottom-toolbar #tbTasksBtn\s*\{\s*margin-left:\s*auto\s*!important/,
        );
      });
    });
  }
});
