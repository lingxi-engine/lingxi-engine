#!/usr/bin/env node
// _copy-backup.mjs - copy tar.gz to F and D with verification
import fs from 'node:fs';
import crypto from 'node:crypto';
import { copyFileSync } from 'node:fs';

const SRC = 'F:/lingxi-engine-v2.0.23.tar.gz';
const DST_D = 'D:/lingxi-engine-v2.0.23.tar.gz';

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Re-copy from source to D
console.log('Copying ' + SRC + ' -> ' + DST_D);
copyFileSync(SRC, DST_D);

const srcSha = sha256(SRC);
const dstSha = sha256(DST_D);
const srcSize = fs.statSync(SRC).size;
const dstSize = fs.statSync(DST_D).size;

console.log('Source: size=' + srcSize + ' sha256=' + srcSha);
console.log('D:      size=' + dstSize + ' sha256=' + dstSha);
console.log('MATCH: ' + (srcSha === dstSha && srcSize === dstSize));
