import { timingSafeEqual } from 'crypto';

/** 恒定时间比较 token，长度不等直接返回 false（长度本身不是秘密） */
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

/**
 * 是否处于开发模式。NODE_ENV=production 时一律视为 false，
 * 避免「线上误开 ALLOW_PUBLIC_ADMIN_AUTO 之类」的开关因为残留的 DEV_MODE=true 而真的生效。
 */
export function isDevMode(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.DEV_MODE === 'false') return false;
  return true;
}