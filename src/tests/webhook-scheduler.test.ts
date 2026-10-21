/**
 * Webhook 调度器回归测试
 *
 * 覆盖：
 *  - allowedIps IP 白名单真正生效（之前只在类型里声明，逻辑完全没检查）
 *  - token 鉴权
 *  - 持久化与恢复
 *  - 禁用/删除
 *  - IP 匹配工具函数（精确 / CIDR / 通配）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WebhookScheduler, isIpAllowed, type WebhookJob } from '../core/webhook-scheduler.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'webhook-test-'));
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('IP 白名单匹配 isIpAllowed', () => {
  it('精确匹配', () => {
    expect(isIpAllowed('192.168.1.10', ['192.168.1.10'])).toBe(true);
    expect(isIpAllowed('192.168.1.11', ['192.168.1.10'])).toBe(false);
  });

  it('CIDR 匹配', () => {
    expect(isIpAllowed('192.168.1.55', ['192.168.1.0/24'])).toBe(true);
    expect(isIpAllowed('192.168.2.55', ['192.168.1.0/24'])).toBe(false);
  });

  it('/32 与 /0 边界', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
    expect(isIpAllowed('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
  });

  it('通配符匹配', () => {
    expect(isIpAllowed('192.168.1.55', ['192.168.1.*'])).toBe(true);
    expect(isIpAllowed('192.168.2.55', ['192.168.1.*'])).toBe(false);
    expect(isIpAllowed('1.2.3.4', ['*'])).toBe(true);
  });

  it('IPv6 前缀归一化', () => {
    expect(isIpAllowed('::ffff:192.168.1.10', ['192.168.1.10'])).toBe(true);
  });

  it('空 IP 不通过', () => {
    expect(isIpAllowed('', ['*'])).toBe(false);
  });
});

describe('WebhookScheduler 触发鉴权', () => {
  it('token 正确才触发', async () => {
    let dispatched = 0;
    const sched = new WebhookScheduler(async () => { dispatched++; }, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '测试', promptTemplate: 'x {payload}' });

    const bad = await sched.trigger(hook.id, 'wrong-token', { payload: 'hi' });
    expect(bad.ok).toBe(false);
    expect(dispatched).toBe(0);

    const good = await sched.trigger(hook.id, hook.secret, { payload: 'hi' });
    expect(good.ok).toBe(true);
    expect(dispatched).toBe(1);
  });

  it('IP 白名单真正生效 —— 白名单外的 IP 被拒绝', async () => {
    let dispatched = 0;
    const sched = new WebhookScheduler(async () => { dispatched++; }, tmpDir);
    sched.start();
    const hook = sched.createHook({
      name: '受限', promptTemplate: 'x {payload}', allowedIps: ['192.168.1.0/24'],
    });

    // 白名单外 → 拒绝
    const outside = await sched.trigger(hook.id, hook.secret, { payload: 'hi' }, '10.0.0.5');
    expect(outside.ok).toBe(false);
    expect(outside.error).toMatch(/白名单/);
    expect(dispatched).toBe(0);

    // 白名单内 → 放行
    const inside = await sched.trigger(hook.id, hook.secret, { payload: 'hi' }, '192.168.1.20');
    expect(inside.ok).toBe(true);
    expect(dispatched).toBe(1);
  });

  it('配置了白名单但没有来源 IP 时拒绝', async () => {
    const sched = new WebhookScheduler(async () => {}, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '受限', promptTemplate: 'x', allowedIps: ['192.168.1.1'] });
    const r = await sched.trigger(hook.id, hook.secret, {}, undefined);
    expect(r.ok).toBe(false);
  });

  it('未配置白名单时不做 IP 限制', async () => {
    let dispatched = 0;
    const sched = new WebhookScheduler(async () => { dispatched++; }, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '不限', promptTemplate: 'x' });
    const r = await sched.trigger(hook.id, hook.secret, {}, '1.2.3.4');
    expect(r.ok).toBe(true);
    expect(dispatched).toBe(1);
  });

  it('禁用的 webhook 不触发', async () => {
    const sched = new WebhookScheduler(async () => {}, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '禁用', promptTemplate: 'x' });
    sched.setEnabled(hook.id, false);
    const r = await sched.trigger(hook.id, hook.secret, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/禁用/);
  });

  it('不存在的 webhook 返回错误', async () => {
    const sched = new WebhookScheduler(async () => {}, tmpDir);
    sched.start();
    const r = await sched.trigger('nope', 'token', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不存在/);
  });

  it('dispatch 抛错时不吞异常，错误信息可读', async () => {
    const sched = new WebhookScheduler(async () => { throw new Error('boom'); }, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '会失败', promptTemplate: 'x' });
    const r = await sched.trigger(hook.id, hook.secret, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
  });
});

describe('WebhookScheduler 持久化', () => {
  it('创建后落盘', () => {
    const sched = new WebhookScheduler(async () => {}, tmpDir);
    sched.start();
    sched.createHook({ name: '持久化', promptTemplate: 'x' });
    const file = join(tmpDir, 'webhooks.json');
    expect(existsSync(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data.length).toBe(1);
    expect(data[0].name).toBe('持久化');
  });

  it('重启后从磁盘恢复', () => {
    const s1 = new WebhookScheduler(async () => {}, tmpDir);
    s1.start();
    const hook = s1.createHook({ name: '恢复', promptTemplate: 'x', allowedIps: ['10.0.0.0/8'] });

    const s2 = new WebhookScheduler(async () => {}, tmpDir);
    s2.start();
    const list = s2.listHooks();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(hook.id);
    expect(list[0].allowedIps).toEqual(['10.0.0.0/8']);
  });

  it('删除后从磁盘移除', () => {
    const sched = new WebhookScheduler(async () => {}, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '待删', promptTemplate: 'x' });
    expect(sched.removeHook(hook.id)).toBe(true);
    const data = JSON.parse(readFileSync(join(tmpDir, 'webhooks.json'), 'utf8'));
    expect(data.length).toBe(0);
  });

  it('触发计数被持久化', async () => {
    const sched = new WebhookScheduler(async () => {}, tmpDir);
    sched.start();
    const hook = sched.createHook({ name: '计数', promptTemplate: 'x' });
    await sched.trigger(hook.id, hook.secret, {});
    await sched.trigger(hook.id, hook.secret, {});
    const data = JSON.parse(readFileSync(join(tmpDir, 'webhooks.json'), 'utf8'));
    expect(data[0].triggerCount).toBe(2);
    expect(typeof data[0].lastTriggerAt).toBe('number');
  });
});
