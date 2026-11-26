# RaiseChat

## 開発フロー

1. `main` から作業ブランチを切る
2. PR を作成する(ドラフトの間は自動レビューされない)
3. Claude Code が自動でレビューコメントを投稿する
4. 指摘を確認・修正して push する(push のたびに再レビュー)
5. 問題なければ人がマージする

## 開発環境のセットアップ

前提: Node.js 22 以上。

```sh
corepack enable        # pnpm を使えるようにする(初回のみ。次の注を参照)
pnpm install
pnpm lint              # ESLint
pnpm typecheck         # 型チェック
pnpm test              # Vitest
pnpm format            # Prettier で整形
```

注: Windows で Node.js を `C:\Program Files\nodejs` に入れている場合、`corepack enable` は、管理者権限がないと `EPERM` で失敗する。その場合は、代わりに `npm install -g pnpm@<バージョン>`(ユーザー領域に入るため、管理者権限は不要)を実行する。`<バージョン>` は、`package.json` の `packageManager` に書かれたバージョンに合わせる(例: `pnpm@12.23.0` なら `npm install -g pnpm@12.23.0`)。更新漏れを避けるため、バージョンは、ここに直接は書かない。

構成: `apps/server`(API)、`apps/web`(画面)、`packages/shared`(共通コード)。設計は [docs/design.md](docs/design.md)、要件は [docs/requirements.md](docs/requirements.md) を参照。

## データベース(ローカル)

Docker が必要。

```sh
pnpm db:up          # docker compose で PostgreSQL 16 を起動する
pnpm db:migrate     # マイグレーションを適用する
pnpm db:generate    # apps/server/src/db/schema.ts を変えたとき、マイグレーションを生成する
pnpm db:down        # 停止する
```

接続先は、環境変数 `DATABASE_URL`(未設定なら、docker compose の既定値)。テストは、テストごとに一時的な DB を作って削除するため、先に `pnpm db:up` が必要。

## サーバーの起動

```sh
cp .env.example .env   # 初回のみ。必要に応じて編集する
pnpm dev:server        # apps/server を、ファイルの変更を監視しながら起動する(既定は http://localhost:3000)
```

`GET /health` で、動作を確認できる。GET 以外のリクエストは、`ALLOWED_ORIGIN` に一致する `Origin` ヘッダがないと、403 になる(CSRF 対策。設計書 §4.1)。
