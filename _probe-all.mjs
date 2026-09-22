#!/usr/bin/env node
/** _probe-all.mjs —— 探测 F/D 盘、打包脚本、当前版本 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const results = {};

// 1. 版本
try {
  results.versionFile = fs.readFileSync('version.txt', 'utf8').trim();
  results.packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
} catch (e) { results.versionErr = e.message; }

// 2. 盘符探测
for (const drive of ['F:', 'D:', 'E:', 'C:']) {
  try {
    const items = fs.readdirSync(drive + '/');
    results[drive] = { ok: true, count: items.length, first: items.slice(0, 8) };
  } catch (e) {
    results[drive] = { ok: false, err: e.message };
  }
}

// 3. 打包脚本
try {
  const s = fs.statSync('scripts/pack-release.ps1');
  results.packScript = { exists: true, size: s.size };
} catch (e) {
  results.packScript = { exists: false, err: e.message };
}

// 4. git 状态
try {
  results.gitLog = execSync('git --no-pager log --oneline -3', { encoding: 'utf8', timeout: 15000 }).trim();
  results.gitStatus = execSync('git status --short', { encoding: 'utf8', timeout: 15000 }).trim() || '(clean)';
} catch (e) { results.gitErr = e.message; }

console.log(JSON.stringify(results, null, 2));
