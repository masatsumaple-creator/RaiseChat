import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// API は、開発サーバーから、サーバー(既定は :3000)へ中継する。
// ブラウザからは、画面と API が同じオリジン(http://localhost:5173)に見えるので、
// Cookie がそのまま届き、Origin の検証(ALLOWED_ORIGIN)も通る。
const API_TARGET = process.env['API_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  // 依存パッケージを、起動時にまとめて最適化する。
  // 実行中に新しく見つかると、Vite が画面を自動で再読み込みし、入力途中の内容が消える(E2E が不安定になる原因)
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'react-router-dom',
      '@tanstack/react-query',
    ],
  },
  server: {
    port: Number(process.env['WEB_PORT'] ?? 5173), // E2E テストは、別のポートで起動する
    strictPort: true, // ALLOWED_ORIGIN と食い違わないよう、ポートが塞がっていたら失敗させる
    proxy: { '/api': { target: API_TARGET } },
  },
});
