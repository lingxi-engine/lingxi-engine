#!/usr/bin/env node
/** _copy-backup.mjs —— 将 tar.gz 复制到 F盘 和 D盘，并做 SHA256 校验 */
import fs from 'node:fs';
import { cp, access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

const SRC = 'C:/Users/Administrator/AppData/Local/Temp/lingxi-engine-v2.0.23.tar.gz';
const TARGETS = ['F:/lingxi-engine-v2.0.23.tar.gz', 'D:/lingxi-engine-v2.0.23.tar.gz'];

async function sha256(p) {
  try {
    return execSync(`certutil -hashfile "${p}" SHA256`, { encoding: 'utf8', timeout: 30000 })
      .split('\n').map(l => l.trim()).find(l => /^[0-9a-f]{64}$/i.test(l))?.toLowerCase() || 'N/A';
  } catch { return 'ERR'; }
}

async function main() {
  if (!fs.existsSync(SRC)) { console.error(`源文件不存在: ${SRC}`); process.exit(1); }
  const srcSize = fs.statSync(SRC).size;
  const srcSha = await sha256(SRC);
  console.log(`源文件: ${SRC}`);
  console.log(`大小: ${(srcSize / 1048576).toFixed(2)} MB`);
  console.log(`SHA256: ${srcSha}`);
  console.log('---');

  for (const dst of TARGETS) {
    try {
      await cp(SRC, dst, { force: true });
      const dstSha = await sha256(dst);
      const dstSize = fs.statSync(dst).size;
      const match = srcSha === dstSha && srcSize === dstSize ? '✅ MATCH' : '❌ MISMATCH';
      console.log(`${dst}`);
      console.log(`  大小: ${(dstSize / 1048576).toFixed(2)} MB | SHA256: ${dstSha} | ${match}`);
    } catch (e) {
      console.log(`${dst}: ❌ 失败 - ${e.message}`);
    }
  }

  // 扫描两个盘上的历史版本
  console.log('---');
  console.log('历史备份扫描:');
  for (const drive of ['F:', 'D:']) {
    try {
      const items = fs.readdirSync(drive + '/');
      const archives = items.filter(f => /lingxi-engine.*\.tar\.gz/.test(f));
      if (archives.length) {
        console.log(`${drive} 上的 lingxi-engine 压缩包:`);
        archives.forEach(f => console.log(`  ${f}`));
      }
    } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
