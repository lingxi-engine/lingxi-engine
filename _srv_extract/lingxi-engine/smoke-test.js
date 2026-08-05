// 灵犀引擎 - API 冒烟测试 v2
const BASE = 'http://127.0.0.1:3456';

let pass = 0, fail = 0;
const results = [];

function record(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  results.push({ name, ok, detail });
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

(async () => {
  console.log('════════ 灵犀引擎 冒烟测试 v2 ════════\n');
  const ts = Date.now();
  const email = `smoke${ts}@test.com`;
  const password = 'SmokeTest123!';
  const display_name = '冒烟用户';

  console.log('── 1. 基础 ──');
  try {
    const r = await fetch(BASE + '/');
    record('GET / 首页', r.status === 200, `status=${r.status}`);
  } catch (e) { record('GET / 首页', false, e.message); }

  console.log('\n── 2. 注册 ──');
  let token = null;
  let userId = null;
  const rr = await api('POST', '/api/auth/register', { email, password, display_name });
  record('POST /api/auth/register', rr.status === 200, `status=${rr.status} ${JSON.stringify(rr.data)}`);
  if (rr.data?.user?.id) userId = rr.data.user.id;
  if (rr.data?.verificationToken) {
    record('注册返回 verificationToken', true);
    const vr = await api('GET', `/api/auth/verify-email?token=${encodeURIComponent(rr.data.verificationToken)}`);
    record('GET /api/auth/verify-email', vr.status === 200, `status=${vr.status} ${JSON.stringify(vr.data)}`);
  }

  console.log('\n── 3. 登录 ──');
  const lr = await api('POST', '/api/auth/login', { email, password });
  record('POST /api/auth/login', lr.status === 200, `status=${lr.status} ${JSON.stringify(lr.data)}`);
  if (lr.data?.accessToken) token = lr.data.accessToken;
  else if (lr.data?.token) token = lr.data.token;

  if (!token) {
    console.log('\n  ⚠️ 无 token，尝试通过数字 ID 登录');
    const lid = await api('POST', '/api/auth/login-by-id', { numeric_id: userId, password });
    record('POST /api/auth/login-by-id', lid.status === 200, `status=${lid.status}`);
    if (lid.data?.accessToken) token = lid.data.accessToken;
    else if (lid.data?.token) token = lid.data.token;
  }

  console.log('\n── 4. 认证 ──');
  if (token) {
    const me = await api('GET', '/api/auth/me', null, token);
    record('GET /api/auth/me (带token)', me.status === 200, `status=${me.status} user=${JSON.stringify(me.data?.user)}`);
  } else {
    record('GET /api/auth/me (带token)', false, '无 token');
  }
  const noAuth = await api('GET', '/api/auth/me');
  record('GET /api/auth/me (无token 应401)', noAuth.status === 401 || noAuth.status === 403, `status=${noAuth.status}`);

  console.log('\n── 5. 受保护接口 (带token) ──');
  if (token) {
    for (const p of ['/api/providers', '/api/ai/config', '/api/agents', '/api/inbox']) {
      const r = await api('GET', p, null, token);
      record(`GET ${p}`, r.status === 200, `status=${r.status}`);
    }
  } else {
    record('受保护接口测试', false, '无 token，跳过');
  }

  console.log('\n── 6. 错误处理 ──');
  const badLogin = await api('POST', '/api/auth/login', { email, password: 'wrongpass' });
  record('错误密码登录→401', badLogin.status === 401, `status=${badLogin.status}`);
  const dupReg = await api('POST', '/api/auth/register', { email, password, display_name: '重复' });
  record('重复注册被拒', dupReg.status === 400, `status=${dupReg.status} ${JSON.stringify(dupReg.data)}`);

  console.log(`\n════════ 结果: ${pass} 通过 / ${fail} 失败 ════════`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
