import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from '../utils/atomic-write.js';

function persistEnvVar(key: string, value: string): void {
  try {
    const envPath = join(process.cwd(), '.env');
    let text = '';
    if (existsSync(envPath)) text = readFileSync(envPath, 'utf8');
    const re = new RegExp('^(' + key + '\\s*=).*$', 'm');
    if (re.test(text)) {
      text = text.replace(re, '$1' + value);
    } else {
      text += (text.endsWith('\n') || text === '' ? '' : '\n') + key + '=' + value + '\n';
    }
    // backup
    try {
      writeFileSync(envPath + '.bak.' + Date.now(), text, { encoding: 'utf8' });
    } catch {}
    atomicWriteFile(envPath, text, { encoding: 'utf8' });
  } catch (e: any) {
    console.warn('[Config] 写入 .env 失败:', e.message);
  }
}

export { persistEnvVar };