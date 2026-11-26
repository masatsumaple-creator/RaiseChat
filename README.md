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
