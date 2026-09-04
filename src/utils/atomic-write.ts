import { writeFileSync, renameSync } from 'fs';
import { dirname, join, basename } from 'path';

export function atomicWriteFile(targetPath: string, content: string, options?: { mode?: number; encoding?: BufferEncoding }) {
  const dir = dirname(targetPath);
  const tmpName = `.${basename(targetPath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2,8)}`;
  const tmpPath = join(dir, tmpName);
  writeFileSync(tmpPath, content, { encoding: options?.encoding || 'utf8' });
  if (options?.mode !== undefined) {
    try { renameSync(tmpPath, targetPath); } catch (e) {
      // attempt to set mode then rename
      try { writeFileSync(tmpPath, content, { encoding: options?.encoding || 'utf8', mode: options.mode }); } catch {}
      renameSync(tmpPath, targetPath);
    }
  } else {
    renameSync(tmpPath, targetPath);
  }
}
