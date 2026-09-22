#!/usr/bin/env node
// _sha-local.mjs - show local file SHA256 and size
import fs from 'node:fs';
import crypto from 'node:crypto';

const f = 'F:/lingxi-engine-v2.0.23.tar.gz';
try {
  const s = fs.statSync(f);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  console.log('exists: true');
  console.log('size: ' + s.size);
  console.log('sha256: ' + sha);
} catch (e) {
  console.log('exists: false - ' + e.message);
}
