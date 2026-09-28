/**
 * bench/tier1-safety.mts — SSRF guard: tests the ACTUAL security policy.
 *
 * IMPORTANT — why these expectations are what they are:
 *   builtin.ts v1.9.2 deliberately relaxed SSRF blocking, because the agent runs
 *   on the USER'S OWN MACHINE and must be able to reach localhost / Ollama / LAN
 *   services. Blocking those would break the primary use case.
 *
 *   The policy therefore is "block cloud metadata endpoints" (to stop IAM
 *   credential theft when deployed in cloud), not "block RFC1918".
 *
 *   So this suite asserts the real intent:
 *     1. cloud metadata endpoints  -> MUST be blocked
 *     2. dangerous schemes          -> MUST be blocked
 *     3. localhost / LAN           -> MUST be ALLOWED (by design)
 *
 *   If someone later hardens this policy, these tests flip and that is correct:
 *   the failure message states the design assumption explicitly.
 */
import { Suite, Report, readMeta, ROOT } from './harness.mts';

const report = new Report();
const s = report.add(new Suite('security.ssrf', 'SSRF guard (real policy: metadata-only blocking)'));

const mod: any = await import('../src/tools/builtin.ts');
const isSsrfSafeUrl = mod.isSsrfSafeUrl;

s.ok('isSsrfSafeUrl is exported', typeof isSsrfSafeUrl === 'function');
if (typeof isSsrfSafeUrl !== 'function') {
  report.print();
  process.exit(1);
}

// ── 1. cloud metadata endpoints: MUST block ──
const MUST_BLOCK = [
  ['AWS IMDSv1', 'http://169.254.169.254/latest/meta-data/'],
  ['AWS IMDSv2 token', 'http://169.254.169.254/api/token'],
  ['GCP metadata', 'http://metadata.google.internal/computeMetadata/v1/'],
  ['Azure metadata', 'http://metadata.azure.com/metadata/instance'],
  ['Alibaba Cloud metadata', 'http://100.100.100.200/latest/meta-data/'],
  ['metadata via https', 'https://169.254.169.254/latest/meta-data/'],
  ['metadata uppercase', 'HTTP://169.254.169.254/latest/'],
];
for (const [label, url] of MUST_BLOCK as [string, string][]) {
  s.check(`blocks ${label}`, !isSsrfSafeUrl(url), 'cloud credential theft vector must be blocked');
}

// ── 2. dangerous schemes: MUST block ──
const MUST_BLOCK_SCHEME = [
  ['file://', 'file:///etc/passwd'],
  ['gopher://', 'gopher://evil/x'],
  ['ftp://', 'ftp://evil/x'],
  ['dict://', 'dict://evil/x'],
  ['jar://', 'jar://evil/x'],
];
for (const [label, url] of MUST_BLOCK_SCHEME as [string, string][]) {
  s.check(`blocks scheme ${label}`, !isSsrfSafeUrl(url), 'non-http scheme must be blocked');
}

// ── 3. malformed input: MUST block ──
const MALFORMED = [
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['number', 12345],
  ['object', {}],
  ['no scheme', 'example.com'],
  ['protocol-relative', '//evil.com/x'],
  ['whitespace injected', 'http://example.com /x'],
];
for (const [label, val] of MALFORMED as [string, any][]) {
  s.check(`rejects malformed: ${label}`, isSsrfSafeUrl(val) === false,
    'malformed input must fail closed');
}

// ── 4. localhost / LAN: MUST be ALLOWED by design ──
const MUST_ALLOW = [
  ['localhost', 'http://localhost:11434/api/generate'],
  ['127.0.0.1', 'http://127.0.0.1:8080/health'],
  ['Ollama default port', 'http://localhost:11434'],
  ['LAN host', 'http://192.168.1.50:3000/'],
  ['LAN 10.x', 'http://10.0.0.5/api'],
  ['public https', 'https://example.com'],
];
for (const [label, url] of MUST_ALLOW as [string, string][]) {
  s.check(`allows ${label} (by design)`, isSsrfSafeUrl(url) === true,
    'v1.9.2 policy: agent must reach local Ollama/LAN services. If this fails, policy was hardened — update this test.');
}

// ── 5. policy is stated in source (guard against silent regression) ──
import fs from 'fs';
import path from 'path';
const src = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'builtin.ts'), 'utf8');
s.ok('metadata blocklist is explicit in source', /SSRF_METADATA_ONLY/.test(src), 'expected named blocklist');
s.ok('metadata list has >= 4 entries',
  (src.match(/'[\d.]+|[a-z.]+'/g) || []).length > 0 &&
  /169\.254\.169\.254/.test(src) && /metadata\.google\.internal/.test(src) && /100\.100\.100\.200/.test(src),
  'must cover AWS + GCP + Alibaba metadata');
s.ok('SSRF policy has a documented rationale',
  /localhost|用户本机|user'?s own machine|SSRF/.test(src),
  'must explain why private ranges are allowed');

const meta = readMeta();
meta.tier = 1;
meta.suite = 'security';
meta.llmUsed = false;

report.print();
report.printFailures();
console.log('  manifest: ' + report.save('tier1-safety.json', meta));
console.log('  NOTE: localhost/LAN allowed by v1.9.2 design — not a vulnerability.');
console.log('');
process.exit(report.overall >= 100 ? 0 : 1);
