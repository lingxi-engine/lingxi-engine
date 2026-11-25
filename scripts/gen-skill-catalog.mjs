// Generate skills/CATALOG.md from the git-tracked (curated) skill set.
// Run: node scripts/gen-skill-catalog.mjs
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const files = execSync('git ls-files skills/', { encoding: 'utf8' })
  .split('\n').map(s => s.trim()).filter(Boolean);

const cats = {
  'Code Quality & Debugging': [],
  'Audit, Security & Release': [],
  'Deployment & Ops': [],
  'AI, Models & Agents': [],
  'Documents & Reports': [],
  'Media & Creative': [],
  'Productivity & Workflow': [],
  'Other': [],
};

function categorize(name, desc) {
  const t = (name + ' ' + desc).toLowerCase();
  if (/security|audit|sensitive|naming-risk|release|verify|closure/.test(t)) return 'Audit, Security & Release';
  if (/deploy|nginx|server|remote|ci|github|install|ubuntu|ops/.test(t)) return 'Deployment & Ops';
  if (/model|provider|ollama|ai|mcp|agent|collab|memory|embedding|rag/.test(t)) return 'AI, Models & Agents';
  if (/bug|debug|fix|code|patch|refactor|review|health|frontend|config|id-harmon/.test(t)) return 'Code Quality & Debugging';
  if (/docx|word|report|material|document|weekly|application/.test(t)) return 'Documents & Reports';
  if (/music|video|comfyui|creative|design|web-design/.test(t)) return 'Media & Creative';
  if (/task|plan|brainstorm|resume|check|feature|preference|scheduled|workflow|comparison/.test(t)) return 'Productivity & Workflow';
  return 'Other';
}

const rows = [];
for (const f of files) {
  const abs = join(root, f);
  if (!existsSync(abs)) continue;
  if (f.endsWith('SKILL.md')) {
    const base = f.split('/')[1];
    rows.push({ name: base, display: base, desc: 'Skill bundle (see SKILL.md)', cat: categorize(base, ''), file: f });
    continue;
  }
  if (!f.endsWith('.json')) continue;
  let raw = readFileSync(abs, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let d; try { d = JSON.parse(raw); } catch { continue; }
  const name = d.name || f.replace(/^skills\//, '').replace(/\.json$/, '');
  const display = d.displayName || name;
  const desc = (d.description || '').replace(/\s+/g, ' ').trim();
  rows.push({ name, display, desc, cat: categorize(name, desc), file: f });
}

for (const r of rows) (cats[r.cat] || cats['Other']).push(r);

let md = '# LingXi Skill Catalog\n\n';
md += `> Curated built-in skills shipped with LingXi Engine. **${rows.length} skills** across ${Object.values(cats).filter(a => a.length).length} categories.\n`;
md += '>\n';
md += '> This catalog is generated from the git-tracked skill set (`node scripts/gen-skill-catalog.mjs`).\n';
md += '> Auto-learned skill variants created at runtime are local-only and never shipped in releases.\n\n';
md += 'Each skill is a JSON prompt-and-tool recipe the engine can reuse for similar tasks. ';
md += 'Enable/disable them via `GET/POST /api/skills` or the Skills panel in the web UI.\n\n';
md += '## Contents\n\n';
for (const [cat, items] of Object.entries(cats)) {
  if (!items.length) continue;
  const anchor = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  md += `- [${cat}](#${anchor}) (${items.length})\n`;
}
md += '\n';
for (const [cat, items] of Object.entries(cats)) {
  if (!items.length) continue;
  md += `## ${cat}\n\n`;
  md += '| Skill | Description |\n|---|---|\n';
  for (const r of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const desc = (r.desc || '—').replace(/\|/g, '\\|');
    md += `| [\`${r.name}\`](../${r.file}) | ${desc} |\n`;
  }
  md += '\n';
}
md += '---\n\n';
md += 'Regenerate after curating skills: `node scripts/gen-skill-catalog.mjs`\n';

writeFileSync(join(root, 'skills', 'CATALOG.md'), md);
console.log(`CATALOG_OK skills=${rows.length}`);
