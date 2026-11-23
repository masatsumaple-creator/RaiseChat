# RaiseChat 設計書

| 項目 | 内容 |
|---|---|
| 版 | 0.1(ドラフト。PR 1: 技術選定・DB スキーマ) |
| 作成日 | 2026-11-23 |
| 前提 | [要件定義書](requirements.md)(0.2 以降) |
| 今後の追加 | PR 2: 認可ルール・REST API 一覧 / PR 3: WebSocket のイベント設計・フェーズ 1 の実装タスク |

**表記ルール**: 要件定義書と同じ。最初に提示された要件にない決定事項は $\color{red}{\text{赤文字}}$ で表記する。設計書は全体が要件定義書からの派生のため、ほぼ全体が赤文字になる。コードブロックは色を付けられないため、ブロック全体が設計案である。

## 1. 技術選定(確定)

| 領域 | 採用 | 理由・補足 |
|---|---|---|
| 言語 | $\color{red}{\text{TypeScript(全体)}}$ | $\color{red}{\text{型を共有できる(要件定義書 §8)}}$ |
| リポジトリ構成 | $\color{red}{\text{pnpm ワークスペース。apps/web、apps/server、packages/shared}}$ | $\color{red}{\text{zod のスキーマと型を、フロントとバックで共有する}}$ |
| バックエンド | $\color{red}{\text{Fastify + zod(入力検証)}}$ | $\color{red}{\text{スキーマから型を作れ、検証を一箇所にまとめられる}}$ |
| ORM・マイグレーション | $\color{red}{\text{Drizzle + drizzle-kit}}$ | $\color{red}{\text{SQL に近く、条件付き更新・ILIKE の ESCAPE・trigram インデックスを素直に書ける}}$ |
| DB | $\color{red}{\text{PostgreSQL 16 以降。拡張は pg\_trgm}}$ | $\color{red}{\text{ローカル開発は docker compose で起動する}}$ |
| リアルタイム | $\color{red}{\text{Socket.IO(単一プロセス。Redis は使わない)}}$ | $\color{red}{\text{ルーム・再接続・ack が標準で付く。数十人規模では単一プロセスで足りる}}$ |
| 認証 | $\color{red}{\text{DB に保存するセッション + HttpOnly Cookie。argon2id}}$ | $\color{red}{\text{キックとパスワード再設定で、セッションを即時に失効させるため}}$ |
| フロント | $\color{red}{\text{React + Vite、TanStack Query、react-markdown + rehype-sanitize}}$ | $\color{red}{\text{サーバー状態の管理と、マークダウンの無害化(FR-106)}}$ |
| ファイル保存 | $\color{red}{\text{保存先を抽象化したインターフェース。開発はローカルディスク、本番は S3 互換}}$ | $\color{red}{\text{§1.1 参照}}$ |
| テスト | $\color{red}{\text{Vitest(単体・結合。DB は実際の PostgreSQL を使う)、Playwright(主要フロー)}}$ | $\color{red}{\text{認可・同時実行(招待の使用回数など)を実 DB で検証するため}}$ |
| CI | $\color{red}{\text{GitHub Actions。lint、型チェック、テスト}}$ | $\color{red}{\text{既存のワークフローに追加する}}$ |

### 1.1 設計上の方針

- $\color{red}{\text{ID: ユーザー・ワークスペース・チャンネルなどは uuid。メッセージだけは、増加する bigint にする。チャンネル内の順序と、既読位置の大小比較に使うため。}}$
- $\color{red}{\text{時刻はすべて timestamptz(UTC)で保存する。}}$
- $\color{red}{\text{ユーザー名は大文字小文字を区別せず一意にする。使える文字は半角英数字とアンダースコア、3〜32 文字。メンション解析を単純にするため。}}$
- $\color{red}{\text{スレッドは 1 段のみ。返信に対する返信はできず、常に親メッセージ(トップレベル)にぶら下がる。}}$
- $\color{red}{\text{メッセージの本文の上限は 4000 文字。文字数は、DB の char\_length と同じコードポイント数で数える。zod 側は、UTF-16 の長さではなく、コードポイント数で検証する(絵文字で DB の CHECK と食い違わないため)。display\_name など他の長さ制限も同様。}}$
- $\color{red}{\text{メッセージの採番(IDENTITY)はコミット順と一致しないため、既読位置の比較で取りこぼしが起こり得る。これを防ぐため、メッセージの挿入は、チャンネル単位の advisory lock(pg\_advisory\_xact\_lock)を取ってから行い、同じチャンネル内の採番順とコミット順を一致させる。}}$
- $\color{red}{\text{キックは、そのワークスペースだけに効く。セッションはユーザー単位でグローバルなので、他のワークスペースのセッションは失効させない。遮断は、WebSocket のルームからの除外と、REST のリクエストごとの所属確認で行う(§2.1)。}}$
- $\color{red}{\text{ログイン試行・パスワード再設定のレート制限は、単一プロセスのためメモリ上で管理する。再起動でリセットされることを許容する。}}$
- $\color{red}{\text{ストレージ上の実体の削除は、DB のトリガで StorageDeletion に積む。チャンネル削除の連鎖削除(CASCADE)でも、取りこぼしが起きないようにするため。}}$

## 2. DB スキーマ

$\color{red}{\text{以下は設計案。型は PostgreSQL。実装時は Drizzle のスキーマ定義に書き直し、マイグレーションを生成する。}}$

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ユーザー(アカウントはグローバル。§9 #3)
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username           text NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{3,32}$'),
  password_hash      text NOT NULL,                 -- argon2id
  recovery_code_hash text NOT NULL,                 -- argon2id(FR-005)
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
  avatar_key         text,                          -- storage_key。未設定は null
  status_text        text NOT NULL DEFAULT '' CHECK (char_length(status_text) <= 100),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));

-- セッション(トークンはハッシュで保存。パスワード再設定時に user_id で一括削除。キックでは削除しない)
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- ワークスペース
CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  owner_id    uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 所属。kicked の行は、キックから解除までの間だけ存在する(FR-302, 304)
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'kicked')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
-- オーナーは各ワークスペースに 1 人。workspaces.owner_id と一致させる(作成時に同じトランザクションで入れる)
CREATE UNIQUE INDEX memberships_one_owner_key ON memberships (workspace_id) WHERE role = 'owner';
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

-- 招待リンク(FR-301)。max_uses が null なら無制限
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  max_uses     integer CHECK (max_uses IS NULL OR max_uses > 0),
  used_count   integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- チャンネル(DM を含む)
CREATE TABLE channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('public', 'private', 'dm')),
  name         text,                                -- dm は null
  created_by   uuid REFERENCES users(id),           -- dm は null
  is_default   boolean NOT NULL DEFAULT false,      -- general。退出・削除不可(FR-203)
  dm_key       text,                                -- DM の重複防止。小さい方の user_id + ':' + 大きい方
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'dm') = (name IS NULL)),
  CHECK ((type = 'dm') = (dm_key IS NOT NULL)),
  CHECK (type = 'dm' OR char_length(name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX channels_name_key ON channels (workspace_id, lower(name)) WHERE type <> 'dm';
CREATE UNIQUE INDEX channels_dm_key ON channels (workspace_id, dm_key) WHERE type = 'dm';
CREATE UNIQUE INDEX channels_default_key ON channels (workspace_id) WHERE is_default;

-- チャンネル参加者と、チャンネル単位の既読位置・ミュート(FR-401, 403)
CREATE TABLE channel_members (
  channel_id            uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id),
  last_read_message_id  bigint NOT NULL DEFAULT 0,
  muted                 boolean NOT NULL DEFAULT false,
  joined_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user_id_idx ON channel_members (user_id);

-- メッセージ。parent_id が null ならトップレベル、そうでなければスレッド返信(1 段のみ)
CREATE TABLE messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  parent_id   bigint,
  body        text CHECK (char_length(body) <= 4000),   -- 削除時は null(FR-104)
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  CHECK ((deleted_at IS NULL) = (body IS NOT NULL)),
  -- 親が同じチャンネルのメッセージであることを DB で保証する(複合外部キー)
  UNIQUE (id, channel_id),
  FOREIGN KEY (parent_id, channel_id) REFERENCES messages (id, channel_id) ON DELETE CASCADE
);
-- チャンネルの履歴(トップレベル)
CREATE INDEX messages_channel_top_idx ON messages (channel_id, id DESC) WHERE parent_id IS NULL;
-- スレッドの返信
CREATE INDEX messages_thread_idx ON messages (parent_id, id) WHERE parent_id IS NOT NULL;
-- 検索(FR-110)。削除済みは索引に含めない
CREATE INDEX messages_body_trgm_idx ON messages USING gin (body gin_trgm_ops) WHERE deleted_at IS NULL;

-- スレッド単位の既読位置(§9 #13)。最初の返信時に親投稿者と返信者の分を作る
CREATE TABLE thread_members (
  root_message_id      bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id),
  last_read_message_id bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (root_message_id, user_id)
);
CREATE INDEX thread_members_user_id_idx ON thread_members (user_id);

-- 添付(FR-107)
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('image', 'video')),
  storage_key   text NOT NULL,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  original_name text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_id_idx ON attachments (message_id);

-- リアクション(FR-108)
CREATE TABLE reactions (
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  emoji       text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- メンション(FR-109)。メッセージ編集時は、既読済みの行を残して差分だけ作り直す
-- read_at は、既読位置とは独立して消し込む(スレッド非参加者へのメンションにも対応するため)
CREATE TABLE mentions (
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  read_at     timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX mentions_unread_idx ON mentions (user_id) WHERE read_at IS NULL;

-- 添付実体の削除キュー(§9 #8)
CREATE TABLE storage_deletions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key   text NOT NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  retry_count   integer NOT NULL DEFAULT 0
);
CREATE INDEX storage_deletions_pending_idx ON storage_deletions (id) WHERE deleted_at IS NULL;

-- 添付行が消えたら(メッセージ削除・チャンネル削除の連鎖を含む)、実体の削除を積む
CREATE FUNCTION enqueue_storage_deletion() RETURNS trigger AS $$
BEGIN
  INSERT INTO storage_deletions (storage_key) VALUES (OLD.storage_key);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attachments_enqueue_deletion
  AFTER DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION enqueue_storage_deletion();
```

### 2.1 スキーマの補足

- $\color{red}{\text{スレッドが 1 段であること(返信の親が、トップレベルのメッセージであること)は、CHECK で表せないため、アプリ側で検証する。親が別チャンネルのメッセージでないことは、複合外部キーで DB が保証する。}}$
- $\color{red}{\text{メッセージの論理削除(FR-104)では、本文を null にして deleted\_at を設定し、リアクション・メンションの行と、添付の行を削除する(添付の削除でトリガが働く)。}}$
- $\color{red}{\text{キック(FR-302)では、アプリ側で 1 つのトランザクションにまとめる: Membership を kicked にする、そのユーザーの ChannelMember と ThreadMember を、このワークスペースの分だけ削除する。セッションは削除しない。キックはそのワークスペースだけに効き、他のワークスペースのセッションと操作には影響しない。遮断は、(1) WebSocket で、そのワークスペースのルームから除外してイベントを送らず、再参加も拒否する、(2) REST で、リクエストごとの所属確認(status が active)により 403 にする、の 2 つで行う。}}$
- $\color{red}{\text{オーナーはキックできない(FR-302)。キックの更新処理で、対象がオーナーでないことを確認する(テスト項目に含める)。}}$
- $\color{red}{\text{パスワード再設定(FR-005)では、そのユーザーの全セッションを削除する。}}$
- $\color{red}{\text{キック解除(FR-304)は、kicked の Membership の行を削除する。}}$
- $\color{red}{\text{DM(FR-102)は type が dm のチャンネルで、dm\_key で同じ 2 人の重複作成を防ぐ。2 人の ChannelMember の行を、作成時に作る。}}$
- $\color{red}{\text{チャンネルのミュートや既読位置は、ワークスペースを超えない(チャンネルが属するワークスペース内で完結する)。}}$
- $\color{red}{\text{チャンネル削除(FR-303)は、チャンネルの行を削除すると、ChannelMember・メッセージ・返信・ThreadMember・リアクション・メンション・添付が連鎖して消え、添付の分はトリガにより StorageDeletion に積まれる。}}$
- $\color{red}{\text{ワークスペースの削除は MVP 対象外(§9 #4)のため、ワークスペースから Membership・Invitation・Channel への連鎖は、将来のために設定してある。}}$
- $\color{red}{\text{アバター画像の差し替え時(FR-004)は、同じトランザクションで、旧ファイルの storage\_key を StorageDeletion に積む。添付と同じ削除キューで扱う。}}$
- $\color{red}{\text{オーナーは、Workspace.owner\_id と、role が owner の Membership の 2 か所で表す。作成時に同じトランザクションで両方を入れる。Membership 側には、1 ワークスペースにつき 1 人の一意制約がある。}}$

## 3. 主要クエリの方針

$\color{red}{\text{実装時の取り違えを防ぐため、要件定義書の基準に関わるクエリの条件を示す。}}$

### 3.1 招待リンクの受諾(FR-301、FR-302)

$\color{red}{\text{次の順序で、1 つのトランザクションで行う。順序を変えない。}}$

1. $\color{red}{\text{トークンのハッシュで招待の行を読み、存在と有効(取り消されていない、期限内)を確認して、workspace\_id を得る。無効なら失敗。}}$
2. $\color{red}{\text{Membership を、ON CONFLICT DO NOTHING で挿入する(role は member、status は active)。}}$
3. $\color{red}{\text{挿入できなかった場合(すでに行がある)は、既存の status を見る。kicked なら失敗(再参加不可)。active なら何もせず成功で終了する(使用回数は増やさない)。}}$
4. $\color{red}{\text{挿入できた場合のみ、下記の条件付き更新で使用回数を消費する。更新が 0 件ならロールバックする(上限に達した)。}}$
5. $\color{red}{\text{既定チャンネル(general)の ChannelMember を挿入する。}}$

$\color{red}{\text{同時に受諾されても、条件付き更新により上限を超えない。確認と挿入の間にキックが入っても、Membership の主キーの競合により、kicked の行があれば再参加できない。結合テストで、同時受諾と、kicked の再参加の両方を確認する。}}$

```sql
-- 手順 4: 使用回数の原子的な消費。更新できた行が 0 件なら上限超過など
UPDATE invitations
   SET used_count = used_count + 1
 WHERE id = $invitation_id
   AND revoked_at IS NULL
   AND expires_at > now()
   AND (max_uses IS NULL OR used_count < max_uses)
RETURNING workspace_id;
```

### 3.2 未読数・メンション数(FR-401、FR-402、FR-207)

```sql
-- チャンネルの未読数(トップレベルのみ。FR-401)
SELECT count(*)
  FROM messages m
  JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $me
 WHERE m.channel_id = $channel
   AND m.parent_id IS NULL
   AND m.deleted_at IS NULL
   AND m.user_id <> $me
   AND m.id > cm.last_read_message_id;

-- 未読のメンション数(ワークスペース単位。ミュート中のチャンネルも数える。FR-207)
SELECT count(*)
  FROM mentions mn
  JOIN messages m ON m.id = mn.message_id AND m.deleted_at IS NULL
  JOIN channels c ON c.id = m.channel_id AND c.workspace_id = $ws
  JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $me
 WHERE mn.user_id = $me
   AND mn.read_at IS NULL;
```

$\color{red}{\text{メンションの既読は、既読位置とは独立して消し込む。チャンネルを開いたとき、そのチャンネルのトップレベルのメンションの read\_at を更新する。スレッドパネルを開いたとき、そのスレッドの返信内のメンションの read\_at を更新する。スレッドに参加していなくても、メンションを受けた人は、スレッドを開くまで未読として数えられる(FR-402)。}}$

### 3.3 検索(FR-110)

```sql
-- $term は \ → % → _ の順にエスケープ済みで、2 文字以上。$cursor は前のページの最後の id(最初は null)
SELECT m.*
  FROM messages m
  JOIN channels c ON c.id = m.channel_id AND c.workspace_id = $ws
  JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $me
 WHERE m.deleted_at IS NULL
   AND m.body ILIKE '%' || $term || '%' ESCAPE '\'
   AND ($cursor IS NULL OR m.id < $cursor)
 ORDER BY m.id DESC
 LIMIT 50;
```

$\color{red}{\text{検索では、参加チャンネルの結合により、権限外のチャンネルと DM が結果に入らない。ワークスペースを指定して検索し、他のワークスペースの結果は混ぜない。ESCAPE の前提は standard\_conforming\_strings がオン(PostgreSQL 16 の既定)。結合テストで、バックスラッシュ・パーセント・アンダースコアを含む語を確認する。}}$

## 4. 未決事項(設計)

| # | 論点 | 暫定案 |
|---|---|---|
| D1 | セッションの有効期限 | $\color{red}{\text{30 日。アクセスのたびに延長しない(固定期限)。30 日ごとに再ログインが必要になることを、仕様として受け入れる}}$ |
| D2 | 添付の保存先の構造 | $\color{red}{\text{storage\_key は、ワークスペース ID、日付、uuid の順のパスにする}}$ |
| D3 | メッセージ編集の履歴 | $\color{red}{\text{保存しない(edited\_at のみ)}}$ |
| D4 | 絵文字の種類 | $\color{red}{\text{Unicode 絵文字のみ(カスタム絵文字は対象外)}}$ |

$\color{red}{\text{D1〜D4 は暫定案。確定の連絡がなければ、この案で進める。}}$
