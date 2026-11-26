import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { startDeletionWorker } from './storage/deletion-queue';
import { LocalDiskStorage } from './storage/storage';

// サーバーの起動。環境変数は、`node --env-file-if-exists=../../.env` で読み込む(package.json の dev / start)。
const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const storage = new LocalDiskStorage(config.storageDir);
const app = buildApp({ config, db, storage });

// 削除キューを、1 分ごとに処理する(失敗した実体の削除を、再試行する)
const deletionWorker = startDeletionWorker(db, storage, {
  onError: (error, key) => app.log.error({ err: error, storageKey: key }, '実体の削除に失敗'),
});

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// 終了の合図(Ctrl+C など)で、処理中のリクエストを終えてから止める
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    deletionWorker.stop();
    void app
      .close()
      .then(() => client.end())
      .then(() => process.exit(0));
  });
}
