// 批次12收尾补丁 v2：内容锚点定位，免疫行号漂移
import { readFileSync, writeFileSync, copyFileSync } from 'fs';

const file = 'src/routes/misc.ts';
copyFileSync(file, '_archive/b12-backup/misc.ts.pre-requireauth.bak');

const raw = readFileSync(file, 'utf8');

// ── 诊断：换行符体系 ──
const lf = (raw.match(/\n/g) || []).length;
const crlf = (raw.match(/\r\n/g) || []).length;
const bom = raw.charCodeAt(0) === 0xFEFF;
console.log(`bytes=${Buffer.byteLength(raw)}  LF=${lf}  CRLF=${crlf}  loneCR=${(raw.match(/\r/g) || []).length - crlf}  BOM=${bom}`);

// ── 锚点断言 ──
const decl = 'export function createMeshRoutes(ctx: ServerContext): Router {';
const declIdx = raw.indexOf(decl);
if (declIdx < 0) { console.error('FAIL: decl anchor not found'); process.exit(1); }
if (raw.indexOf(decl, declIdx + 1) >= 0) { console.error('FAIL: decl anchor not unique'); process.exit(1); }

const raCount = raw.split('const requireAuth').length - 1;
if (raCount !== 1) { console.error(`FAIL: expected exactly 1 existing 'const requireAuth', found ${raCount}`); process.exit(1); }

// decl 之后第一行必须是 const router = Router();
const afterDecl = raw.slice(declIdx);
const firstNl = afterDecl.indexOf('\n');
const nextLine = afterDecl.slice(firstNl + 1, afterDecl.indexOf('\n', firstNl + 1)).trim();
if (nextLine !== 'const router = Router();') {
  console.error(`FAIL: line after decl is "${nextLine}", expected "const router = Router();"`);
  process.exit(1);
}

// ── 落刀：在 const router = Router(); 行后插入 ──
const nl = crlf === lf ? '\r\n' : (lf > crlf ? '\n' : '\r\n');
const inject = `  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;`;
const routerLineAbsStart = declIdx + firstNl + 1;
const routerLineAbsEnd = raw.indexOf('\n', routerLineAbsStart); // 指向行尾 \n 的位置
const insertPos = routerLineAbsEnd + 1;

const out = raw.slice(0, insertPos) + inject + nl + raw.slice(insertPos);
writeFileSync(file, out);

// ── 自检 ──
const out2 = readFileSync(file, 'utf8');
const raAfter = out2.split('const requireAuth').length - 1;
console.log(`PATCH OK: injected after router line. requireAuth count: ${raCount} -> ${raAfter}`);
if (raAfter !== 2) { console.error('FAIL: post-check count != 2'); process.exit(1); }
console.log('New byte size:', Buffer.byteLength(out2));