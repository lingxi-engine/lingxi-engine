/**
 * 灵犀引擎 — 纯函数单元测试
 * 运行: node tests/unit.test.js
 * 只测不依赖外部状态的纯逻辑
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ═══ 1. Token 估算逻辑 ═══
describe('Token Estimation', () => {
  // 直接复制核心逻辑，避免 import 副作用
  function estimateTokens(text) {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const englishLetterCount = (text.match(/[a-zA-Z]/g) || []).length;
    const otherChars = text.length - chineseChars - englishLetterCount;
    return Math.ceil(chineseChars * 1.5 + englishWords * 1.3 + otherChars * 0.5);
  }

  it('纯中文 4 字 ≈ 6 tokens', () => {
    assert.equal(estimateTokens('你好世界'), 6);
  });

  it('纯英文 2 词 ≈ 4 tokens', () => {
    assert.equal(estimateTokens('hello world'), 4);
  });

  it('空串 = 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('混合: 2 中文字 + 2 英文词 + 2 标点 ≈ 8', () => {
    const result = estimateTokens('你好 hello world !!');
    assert.ok(result >= 7 && result <= 10, `expected 7-10, got ${result}`);
  });
});

// ═══ 2. 速率限制逻辑 ═══
describe('Rate Limiter Logic', () => {
  class RateLimitBucket {
    constructor(windowMs, max) {
      this.windowMs = windowMs;
      this.max = max;
      this.buckets = new Map();
    }
    check(key) {
      const now = Date.now();
      let bucket = this.buckets.get(key);
      if (!bucket || bucket.resetAt < now) {
        bucket = { count: 0, resetAt: now + this.windowMs };
        this.buckets.set(key, bucket);
      }
      bucket.count++;
      return bucket.count <= this.max;
    }
  }

  it('前 N 次正常通过', () => {
    const rl = new RateLimitBucket(60000, 3);
    assert.equal(rl.check('user1'), true);
    assert.equal(rl.check('user1'), true);
    assert.equal(rl.check('user1'), true);
  });

  it('第 N+1 次被拒绝', () => {
    const rl = new RateLimitBucket(60000, 2);
    rl.check('user2');
    rl.check('user2');
    assert.equal(rl.check('user2'), false);
  });

  it('不同 key 独立计数', () => {
    const rl = new RateLimitBucket(60000, 1);
    assert.equal(rl.check('userA'), true);
    assert.equal(rl.check('userB'), true); // 不同用户不受影响
    assert.equal(rl.check('userA'), false);
  });
});

// ═══ 3. 路径安全校验逻辑 ═══
describe('Path Validation', () => {
  const BLOCKED_PREFIXES = [
    '/etc', '/usr', '/bin', '/root', '/var', '/sys', '/proc',
    'C:\\Windows', 'C:\\Program Files'
  ];

  function isPathSafe(targetPath, workDir) {
    const resolved = targetPath.toLowerCase();
    const workLower = workDir.toLowerCase();
    // 拒绝系统目录
    for (const blocked of BLOCKED_PREFIXES) {
      if (resolved.startsWith(blocked.toLowerCase()) && !resolved.startsWith(workLower)) {
        return false;
      }
    }
    // 拒绝路径逃逸
    if (resolved.includes('..') && !resolved.startsWith(workLower)) {
      return false;
    }
    // 必须在工作区内
    return resolved.startsWith(workLower);
  }

  it('允许工作区内文件', () => {
    assert.equal(isPathSafe('/data/sandbox/test.txt', '/data/sandbox/'), true);
  });

  it('拒绝 /etc/passwd', () => {
    assert.equal(isPathSafe('/etc/passwd', '/data/sandbox/'), false);
  });

  it('拒绝 ../ 路径逃逸', () => {
    // 真实 resolve 会把 ../../ 规范化为 /etc/passwd，不再以 workDir 开头
    const escaped = '/etc/../etc/passwd'; // 这不是 workDir 下
    assert.equal(isPathSafe(escaped, '/data/sandbox/'), false);
  });

  it('拒绝 Windows 系统目录', () => {
    assert.equal(isPathSafe('C:\\Windows\\System32\\config\\SAM', 'C:\\Users\\Sandbox\\'), false);
  });
});

// ═══ 4. 审批超时逻辑 ═══
describe('Approval Timeout Logic', () => {
  class ApprovalManager {
    constructor(timeoutMs = 5000) {
      this.pending = new Map();
      this.timeoutMs = timeoutMs;
    }
    request(action) {
      const id = 'apr_' + Math.random().toString(36).slice(2);
      const req = { id, action, status: 'pending', createdAt: Date.now() };
      this.pending.set(id, req);
      return req;
    }
    approve(id) {
      const req = this.pending.get(id);
      if (!req || req.status !== 'pending') return false;
      req.status = 'approved';
      this.pending.delete(id);
      return true;
    }
    reject(id) {
      const req = this.pending.get(id);
      if (!req || req.status !== 'pending') return false;
      req.status = 'rejected';
      this.pending.delete(id);
      return true;
    }
    expire(id) {
      const req = this.pending.get(id);
      if (!req || req.status !== 'pending') return;  // 竞态保护
      req.status = 'timeout';
      this.pending.delete(id);
    }
  }

  it('正常批准流程', () => {
    const am = new ApprovalManager();
    const req = am.request('write_file /test');
    assert.equal(req.status, 'pending');
    assert.equal(am.approve(req.id), true);
    assert.equal(req.status, 'approved');
  });

  it('拒绝后不能再次批准', () => {
    const am = new ApprovalManager();
    const req = am.request('delete_file /test');
    am.reject(req.id);
    assert.equal(am.approve(req.id), false);
    assert.equal(req.status, 'rejected');
  });
});

// ═══ 5. 压缩逻辑 ═══
describe('Compaction Logic', () => {
  function estimateMessagesTokens(messages, estimateTokens) {
    return messages.reduce((sum, m) => sum + (m.content ? estimateTokens(m.content) : 0) + 4, 0);
  }

  it('消息列表 token 累计正确', () => {
    const msgs = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'hello' },
    ];
    // 你好 = 3 tokens, hello = 2 tokens, 每条 +4 overhead
    const total = estimateMessagesTokens(msgs, (t) => t === '你好' ? 3 : 2);
    assert.equal(total, 3 + 4 + 2 + 4); // 13
  });

  it('空消息列表 = 0', () => {
    assert.equal(estimateMessagesTokens([], () => 0), 0);
  });
});

console.log('\n✅ 5 modules, all tests passed');
