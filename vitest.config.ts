import { defineConfig } from 'vitest/config';

// 2026-09-04: 限定测试范围，避免扫到 lingxi-repo/workspace 等诊断用 clone 目录
// （里面的旧版测试与主仓库 API 不匹配，会造成大量假失败）
// 注意：vitest 的 exclude 需要用 **/ 前缀才能匹配子目录中的绝对路径
export default defineConfig({
  include: ['src/tests/**/*.test.ts', 'src/**/*.test.ts', 'tests/**/*.test.ts'],
  exclude: [
    '**/node_modules/**',
    '**/lingxi-repo/**',
    '**/workspace/**',
    '**/dist/**',
  ],
});