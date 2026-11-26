import { buildApp } from './app';
import { loadConfig } from './config';

// サーバーの起動。環境変数は、`node --env-file-if-exists=../../.env` で読み込む(package.json の dev / start)。
const config = loadConfig();
const app = buildApp({ config });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// 終了の合図(Ctrl+C など)で、処理中のリクエストを終えてから止める
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
