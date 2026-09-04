import { readFileSync } from 'fs';

// Read package.json robustly in ESM and set global version used by health endpoint
try {
  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(pkgText || '{}');
  (globalThis as any).__LINGXI_VERSION__ = pkg.version || 'dev';
} catch (e: any) {
  console.warn('[version] failed to read package.json:', e?.message || e);
  (globalThis as any).__LINGXI_VERSION__ = 'dev';
}
