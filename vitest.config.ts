import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 実 DB を使うテストは、ファイルごとに DB を作ってマイグレーションを流す。並列で動くと、既定の 5 秒を超えることがある
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
