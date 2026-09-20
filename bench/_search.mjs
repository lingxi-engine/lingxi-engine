import fs from 'fs';
import path from 'path';

const ROOT = 'C:/Users/Administrator/lingxi-engine';
const TARGET = 'setSessionWorkspaceSubdir';

function walk(dir, depth=0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, depth+1); }
    else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes(TARGET)) {
          const lines = content.split('\n').map((l,i) => `${i+1}: ${l}`).filter(l => l.includes(TARGET));
          console.log(`FOUND: ${full}`);
          lines.forEach(l => console.log(`  ${l}`));
        }
      } catch {}
    }
  }
}

walk(ROOT);
console.log('--- done ---');
