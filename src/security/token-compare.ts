import { timingSafeEqual } from 'crypto';

export function timingSafeTokenEqual(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isDevMode(): boolean {
  if (process.env.DEV_MODE === 'true') return true;
  if (process.env.NODE_ENV === 'production') return false;
  return true;
}
