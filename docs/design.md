# RaiseChat 設計書

| 項目 | 内容 |
|---|---|
| 版 | 0.3(ドラフト。PR 1: 技術選定・DB スキーマ、PR 2: 認可ルール・REST API 一覧、PR 3: WebSocket・フェーズ 1 の実装タスク) |
| 作成日 | 2026-11-23 |
| 前提 | [要件定義書](requirements.md)(0.2 以降) |
| 今後の追加 | フェーズ 2 以降の実装タスクは、各フェーズの開始時に、この文書へ追加する |

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
3. $\color{red}{\text{挿入できなかった場合(すでに行がある)は、既存の status を見る。kicked なら失敗(再参加不可。応答は、無効なリンクと同じ 404 で、kicked であることを知らせない)。active なら何もせず成功で終了する(使用回数は増やさない)。}}$
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

## 4. 認可ルール

$\color{red}{\text{認可は、リクエストのたびに DB で確認する。所属情報をキャッシュしたり、トークンに埋め込んだりしない(キック・退出の即時反映と、IDOR 対策のため)。}}$

### 4.1 認証と共通のガード

- $\color{red}{\text{認証: セッション Cookie(HttpOnly、Secure、SameSite=Lax)。リクエストごとに sessions を引き、期限内か確認する。}}$
- $\color{red}{\text{CSRF 対策: GET 以外のリクエストは、Origin ヘッダが許可するオリジンと一致しなければ 403 で拒否する。Origin ヘッダがない場合も拒否する(Referer や Sec-Fetch-Site で代替しない)。ブラウザは、同じオリジンからの GET 以外のリクエストにも Origin を付けるため、正規の画面には影響しない。状態を変える操作を GET で行わない。WebSocket のハンドシェイクの Origin 検証は、PR 3 で定義する。}}$
- $\color{red}{\text{レート制限(§1.1 のとおりメモリ上で管理し、超過は 429)の対象は、次のとおり。(1) 登録・ログイン・パスワード再設定。再設定は FR-005 の基準に従う。(2) 招待リンクの確認と受諾。トークンが無効だった試行(存在しない・期限切れ・取り消し・回数超過・kicked を区別せず、すべて失敗として数える)だけを数え、ユーザー単位で 15 分に 10 回、同一 IP 全体で 15 分に 30 回とする。有効なリンクの利用は、数えない。トークンの総当たりと、有効性の探索を防ぐため。IP の取得元は、リバースプロキシの背後では、設定で指定した信頼するプロキシのアドレスから届いた X-Forwarded-For だけを使い(Fastify の trustProxy を、プロキシのアドレスに限定して設定する)、それ以外の経路では、ヘッダを無視して接続元のアドレスを使う(ヘッダの偽装で制限を回避されないため)。同じ NAT の内側の別のユーザーが、失敗を重ねると、IP 単位の上限に達して、正規のユーザーも 429 になり得るが、小規模の利用では許容する(15 分で解除される)。}}$

共通のガード(サーバー内の関数)を、次のとおり定義する。API の認可は、これらの組み合わせで書く。

| ガード | 条件 | 失敗時 |
|---|---|---|
| requireUser | $\color{red}{\text{有効なセッションがある}}$ | $\color{red}{\text{401}}$ |
| requireMember(ws) | $\color{red}{\text{そのワークスペースの Membership が active}}$ | $\color{red}{\text{kicked なら 403、行がなければ 404}}$ |
| requireOwner(ws) | $\color{red}{\text{requireMember を満たし、role が owner}}$ | $\color{red}{\text{403}}$ |
| requireChannel(ch) | $\color{red}{\text{チャンネルが存在し、呼び出し者の ChannelMember の行がある。判定は ChannelMember の行だけで行う(kick 時にそのワークスペースの ChannelMember の行は削除されるため、kicked のユーザーは、行がなく、必ず 404 になる)}}$ | $\color{red}{\text{常に 404(存在しない場合、別のワークスペースの場合、非参加の場合、kicked の場合を区別しない)。403 は返さない}}$ |
| requireAuthor(msg) | $\color{red}{\text{requireChannel を満たし、メッセージが削除済みでなく、投稿者が本人}}$ | $\color{red}{\text{削除済みなら 404(投稿者以外にも 404)。投稿者以外は 403}}$ |

$\color{red}{\text{ステータスの原則: ワークスペースを指定する API(パスに /workspaces/:ws を含むもの)は、kicked なら 403、Membership の行がなければ 404(FR-302)。チャンネルまたはメッセージを指定する API は、ChannelMember の行がなければ、kicked を含めて 404(存在を隠す)。例外は、参加(join)、チャンネル削除、プライベートチャンネルへの招待(いずれも §4.4 に順序を定義)と、招待リンクの API(§5.2)。結合テストでは、これらの例外の各ステータスと、オーナーによる自己追加の 403 を確認する。}}$

メッセージ ID を指定する API(パスが /messages/:id で始まるもの、および添付の取得)は、まず ID からメッセージと、その channel を引き、次の順で認可する。上から順に判定し、最初に当てはまったところで終了する。

1. $\color{red}{\text{メッセージが存在しない場合は 404。}}$
2. $\color{red}{\text{そのチャンネルに対する requireChannel を満たさない場合は 404(別のワークスペース、非参加のプライベートチャンネル、他人の DM、kicked を含む)。}}$
3. $\color{red}{\text{メッセージが削除済みの場合の扱いは、下記のとおり。}}$
4. $\color{red}{\text{編集・削除の場合は、さらに投稿者を確認する(投稿者以外は 403)。}}$

$\color{red}{\text{削除済みのメッセージ(deleted\_at が設定されている)への操作は、次のとおり。(1) 編集・再度の削除・リアクションの付与・新しい返信の投稿は、404(編集と削除は、投稿者以外にも 404 を返し、403 より先に判定する)。(2) リアクションの解除は、冪等な操作とし、自分のリアクションがなくても、常に成功を返す(削除前に付けたリアクションの解除も、成功になる)。(3) 既存の返信の取得と閲覧は、スレッドが「削除されました」の親の下に残る(FR-105)ため、可能。}}$

### 4.2 権限マトリクス(要件定義書 §3 の具体化)

| 操作 | ガード |
|---|---|
| ワークスペース作成 | $\color{red}{\text{requireUser}}$ |
| 招待リンクの発行・一覧・取り消し | $\color{red}{\text{requireOwner}}$ |
| 招待リンクの受諾 | $\color{red}{\text{requireUser(Membership の確認は §3.1 の手順)}}$ |
| キック・キック解除 | $\color{red}{\text{requireOwner。対象がオーナー自身なら 400}}$ |
| チャンネル作成 | $\color{red}{\text{requireMember}}$ |
| チャンネル削除 | $\color{red}{\text{active なオーナーのみ。判定の順序と失敗時のステータスは §4.4(既定チャンネル(general)と DM は 400)}}$ |
| パブリックチャンネルの一覧(未参加のものを含む) | $\color{red}{\text{requireMember}}$ |
| パブリックチャンネルへの参加 | $\color{red}{\text{requireMember(チャンネルが public であること)}}$ |
| チャンネルからの退出 | $\color{red}{\text{requireChannel。既定チャンネルと DM は 400}}$ |
| プライベートチャンネルへの招待 | $\color{red}{\text{作成者(Channel.created\_by)で、かつ参加者、またはオーナー。対象は、同じワークスペースの active メンバーのみ}}$ |
| チャンネル管理一覧(プライベートの名前を含む) | $\color{red}{\text{requireOwner}}$ |
| メッセージの閲覧・投稿 | $\color{red}{\text{requireChannel}}$ |
| メッセージの検索 | $\color{red}{\text{requireMember。結果は、自分が参加しているチャンネルと DM のみ(§3.3 の結合で絞る)}}$ |
| メッセージの編集・削除 | $\color{red}{\text{requireAuthor}}$ |
| リアクションの付与・解除 | $\color{red}{\text{requireChannel(自分の分だけ。付与は削除済みメッセージに不可、解除は冪等で常に成功)}}$ |
| 添付ファイルの取得 | $\color{red}{\text{添付が属するメッセージのチャンネルに対する requireChannel。削除済みメッセージの添付は 404}}$ |
| プロフィールの変更 | $\color{red}{\text{requireUser(自分のみ)}}$ |
| 他ユーザーのアバターの取得 | $\color{red}{\text{requireUser。かつ、本人、または、同じワークスペースに共に active で所属している(それ以外は 404)}}$ |

### 4.3 エラーの方針

- $\color{red}{\text{エラー形式は、HTTP ステータスと、code と message を持つ JSON。message には、内部情報や存在の有無を含めない。}}$
- $\color{red}{\text{存在を隠す対象(非所属のワークスペース、非参加のプライベートチャンネル)は、権限がない場合も存在しない場合も同じ 404 を返す。}}$
- $\color{red}{\text{ログイン・パスワード再設定の失敗は、理由を特定しない同一の文言で、同等の処理時間にする(FR-002、FR-005)。}}$

### 4.4 チャンネルを指定する操作の失敗時のステータス

$\color{red}{\text{存在を隠すべき相手(参加者でない人)には 404、存在を知っている相手(参加者)には、理由が分かるステータスを返す。次の順序で判定し、最初に当てはまったところで終了する。}}$

| 操作 | 判定の順序と結果 |
|---|---|
| 参加(join) | $\color{red}{\text{(1) チャンネルが存在しない、または呼び出し者がそのチャンネルのワークスペースに Membership の行を持たない、またはチャンネルがプライベート・DM → 404。(2) 呼び出し者が kicked → 403(FR-302。kicked のユーザーは、そのワークスペースのパブリックチャンネルの存在が分かるが、キック前から知り得た情報であり、許容する)。(3) パブリックなら参加する(参加済みなら成功)。}}$ |
| 退出(leave) | $\color{red}{\text{(1) 参加者でない(存在しない場合、別のワークスペースの場合、kicked の場合を含む) → 404。(2) 既定チャンネルまたは DM → 400。(3) 退出する。}}$ |
| チャンネル削除 | $\color{red}{\text{(1) チャンネルが存在しない → 404。(2) 呼び出し者が、そのチャンネルのワークスペースの active なオーナーでない場合は、次のとおり。呼び出し者がそのチャンネルの参加者である、または、チャンネルがパブリックで呼び出し者が active メンバーである → 403(存在を知っている)。それ以外(非参加のプライベート・DM、別のワークスペース、kicked) → 404。(3) オーナーで、チャンネルが DM → 参加者なら 400、非参加なら 404(DM の存在を隠す)。(4) 既定チャンネル(general) → 400。(5) 削除する。}}$ |
| プライベートへの招待 | $\color{red}{\text{(1) チャンネルが存在しない → 404。(2) 呼び出し者が、そのチャンネルの参加者でも、active なオーナーでもない(別のワークスペース、kicked を含む) → 404。(3) 呼び出し者がオーナーで参加者でなく、チャンネルが DM → 404(DM の存在を隠す)。(4) チャンネルが DM またはパブリック → 400。(5) 呼び出し者が、作成者でもオーナーでもない(参加者だけ) → 403。(6) 作成者は、参加者である間だけ有効(退出・キックされると、(5) の対象になる)。(7) 呼び出し者がオーナーで参加者でなく、招待する対象が自分自身 → 403(下記)。(8) 招待する対象が、同じワークスペースの active メンバーでない → 400。(9) 招待する(対象がすでに参加者なら成功)。}}$ |

$\color{red}{\text{オーナーは、参加者でないプライベートチャンネルにも、他のユーザーを追加できる。ただし、自分自身を追加することはできない。管理一覧では名前だけを見せ、内容は見せない方針(FR-204、303)を、オーナーが迂回できないようにするため。内容を見たい場合は、チャンネルの作成者または参加者から招待される必要がある。}}$

## 5. REST API 一覧

$\color{red}{\text{パスの先頭に /api を付ける。ID は uuid(メッセージのみ数値)。JSON を送受信し、添付つきの投稿だけ multipart/form-data を使う。一覧の取得は、新しい順の 50 件ずつで、cursor(前のページの最後の ID)で次を取る。パスはコードで表記し、色は付けない。}}$

### 5.1 認証・ユーザー

| メソッド・パス | 認可 | 概要 | FR |
|---|---|---|---|
| `POST /auth/register` | $\color{red}{\text{なし}}$ | $\color{red}{\text{ユーザー名とパスワードで登録。リカバリーコードを一度だけ返す}}$ | 001 |
| `POST /auth/login` | $\color{red}{\text{なし}}$ | $\color{red}{\text{ログイン。セッション Cookie を発行}}$ | 002 |
| `POST /auth/logout` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{現在のセッションを削除}}$ | 003 |
| `POST /auth/recover` | $\color{red}{\text{なし}}$ | $\color{red}{\text{ユーザー名・リカバリーコード・新パスワードで再設定。全セッションを削除し、新しいコードを返す}}$ | 005 |
| `GET /me` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{自分のプロフィール}}$ | 004 |
| `PATCH /me` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{表示名・ステータスの変更}}$ | 004 |
| `PUT /me/avatar` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{アバター画像の差し替え(multipart)。旧ファイルは削除キューへ}}$ | 004 |
| `GET /users/:userId/avatar` | $\color{red}{\text{requireUser。かつ、本人、または、自分と対象が同じワークスペースに共に active で所属している}}$ | $\color{red}{\text{アバター画像の取得。条件を満たさない場合、対象が存在しない場合、アバターが未設定の場合は、いずれも同じ 404}}$ | 004 |

### 5.2 ワークスペース・招待・メンバー

| メソッド・パス | 認可 | 概要 | FR |
|---|---|---|---|
| `GET /workspaces` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{自分が active に所属するワークスペースの一覧。それぞれのメンション数と未読の有無(横断バッジ)を含む}}$ | 206, 207 |
| `POST /workspaces` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{作成。作成者がオーナーになり、general が作られる}}$ | 201 |
| `GET /workspaces/:ws` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{ワークスペースの情報}}$ | 206 |
| `GET /workspaces/:ws/members` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{active なメンバー一覧(表示名・アバター・ステータス)}}$ | 004 |
| `POST /workspaces/:ws/invitations` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{招待リンクの発行(有効期限・回数を指定)。トークンは、この応答でだけ返す}}$ | 301 |
| `GET /workspaces/:ws/invitations` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{発行済みリンクの一覧(トークンは返さない)}}$ | 301 |
| `DELETE /workspaces/:ws/invitations/:id` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{リンクの取り消し(revoked\_at を設定)}}$ | 301 |
| `GET /invitations/:token` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{受諾前の確認。ワークスペース名と、有効かどうかだけを返す。無効の場合は、理由(存在しない・期限切れ・取り消し・回数超過・kicked)を区別せず、同じ 404 と同じ文言を返す。レート制限の対象(§4.1)}}$ | 301 |
| `POST /invitations/:token/accept` | $\color{red}{\text{requireUser}}$ | $\color{red}{\text{招待の受諾(§3.1 の手順)。参加済みなら成功を返す。失敗は、上記の確認と同じ 404 と同じ文言で、kicked の場合も区別しない。レート制限の対象(§4.1)}}$ | 301 |
| `POST /workspaces/:ws/members/:userId/kick` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{キック(§2.1 の手順)。WebSocket のルームからも除外する}}$ | 302 |
| `GET /workspaces/:ws/kicked` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{キック済みユーザーの一覧}}$ | 304 |
| `DELETE /workspaces/:ws/kicked/:userId` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{キックの解除(Membership の行を削除)}}$ | 304 |

### 5.3 チャンネル・DM

| メソッド・パス | 認可 | 概要 | FR |
|---|---|---|---|
| `GET /workspaces/:ws/channels` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{参加中のチャンネル・DM(未読数・メンション数・ミュート状態つき)。query で、未参加のパブリックチャンネルの一覧も取れる}}$ | 203, 401 |
| `GET /workspaces/:ws/channels/admin` | $\color{red}{\text{requireOwner}}$ | $\color{red}{\text{全チャンネルの管理一覧。プライベートは名前のみ}}$ | 204, 303 |
| `POST /workspaces/:ws/channels` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{作成(名前・種別)。作成者は参加者になる}}$ | 202 |
| `DELETE /channels/:ch` | $\color{red}{\text{チャンネルのワークスペースの active なオーナー。判定順序は §4.4}}$ | $\color{red}{\text{削除。連鎖して配下を削除し、添付は削除キューへ。WebSocket のルームも閉じる}}$ | 303 |
| `POST /channels/:ch/join` | $\color{red}{\text{requireMember(チャンネルのワークスペース)}}$ | $\color{red}{\text{パブリックチャンネルへの参加。チャンネルが存在しない場合、プライベートの場合、DM の場合は、いずれも同じ 404(存在を隠す)。すでに参加済みなら成功を返す}}$ | 203 |
| `POST /channels/:ch/leave` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{退出。既定チャンネル(general)と DM は 400(参加者は存在を知っているため、隠す必要がない)}}$ | 203, 204 |
| `GET /channels/:ch/members` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{参加者の一覧。query で絞り込み(メンション候補に使う)}}$ | 109 |
| `POST /channels/:ch/members` | $\color{red}{\text{チャンネルの作成者で参加者、またはオーナー。判定の順序と失敗時のステータスは §4.4}}$ | $\color{red}{\text{プライベートチャンネルへの招待(対象ユーザー ID)}}$ | 204 |
| `PATCH /channels/:ch/me` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{自分のミュート設定}}$ | 403 |
| `POST /workspaces/:ws/dms` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{相手のユーザー ID を指定して DM を作成。すでにあれば、それを返す。相手は、同じワークスペースの active メンバーのみ。自分自身との DM は、作成できず 400(将来の検討事項)。相手が kicked または他のワークスペースのユーザーの場合は 400}}$ | 102 |

### 5.4 メッセージ

| メソッド・パス | 認可 | 概要 | FR |
|---|---|---|---|
| `GET /channels/:ch/messages` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{トップレベルのメッセージを新しい順に取得(返信数、リアクション、添付つき)。cursor で次のページ。after パラメータ(指定した ID より新しいメッセージを、古い順に 50 件)で、再接続後の取りこぼしを取得できる(§6.5)}}$ | 101, 105 |
| `POST /channels/:ch/messages` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{投稿。本文のみは JSON、添付つきは multipart。メンションを解析して登録し、WebSocket で配信}}$ | 101, 107, 109 |
| `GET /messages/:id/replies` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{スレッドの返信を古い順に取得}}$ | 105 |
| `POST /messages/:id/replies` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{返信の投稿。親はトップレベルのみ。ThreadMember を作成・追加}}$ | 105 |
| `PATCH /messages/:id` | $\color{red}{\text{requireAuthor}}$ | $\color{red}{\text{本文の編集。edited\_at を設定し、メンションを差分更新}}$ | 103 |
| `DELETE /messages/:id` | $\color{red}{\text{requireAuthor}}$ | $\color{red}{\text{論理削除(§2.1)。親メッセージなら、返信は残す}}$ | 104 |
| `PUT /messages/:id/reactions/:emoji` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{リアクションの付与(すでにあれば成功を返す)}}$ | 108 |
| `DELETE /messages/:id/reactions/:emoji` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{自分のリアクションの解除}}$ | 108 |
| `GET /attachments/:id` | $\color{red}{\text{添付のチャンネルに requireChannel}}$ | $\color{red}{\text{添付の取得。nosniff を付け、許可形式以外は返さない}}$ | 107 |
| `GET /workspaces/:ws/search` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{検索(q は 2 文字以上、cursor)。参加チャンネルのみが対象}}$ | 110 |

### 5.5 既読・未読

| メソッド・パス | 認可 | 概要 | FR |
|---|---|---|---|
| `POST /channels/:ch/read` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{チャンネルの既読位置を更新(戻さない)。そのチャンネルのトップレベルのメンションを既読にする}}$ | 401 |
| `POST /messages/:id/thread/read` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{スレッドの既読位置を更新(戻さない)。そのスレッドのメンションを既読にする}}$ | 401, 402 |
| `GET /workspaces/:ws/threads` | $\color{red}{\text{requireMember}}$ | $\color{red}{\text{自分が参加しているスレッドの一覧と、未読の有無(サイドバーの「スレッド」項目)}}$ | 401 |

### 5.6 補足

- $\color{red}{\text{メンションの解析: 本文から、アットマークとユーザー名の並びを取り出し、そのチャンネルの参加者に当てはまる分だけ Mention に登録する。参加者でない名前は、通常の文字として扱い、通知しない(FR-109)。}}$
- $\color{red}{\text{マークダウン(FR-106)の無害化: サーバーは、本文を入力されたままのマークダウンの文字列として保存し、HTML への変換も無害化の加工もしない。表示するときに、クライアントが react-markdown と rehype-sanitize で変換と無害化を行う。生の HTML は描画しない。そのため、FR-106 に対応する API はない。検索は、変換前の文字列に対して行う。}}$
- $\color{red}{\text{既読位置は、戻さない。小さい ID で更新しようとしたら、何もしない。}}$
- $\color{red}{\text{添付とアバターは、拡張子と Content-Type ではなく、ファイル内容で形式を判定する(FR-107)。}}$
- $\color{red}{\text{ヘルスチェック用に、認証なしの GET /health を設ける。}}$

## 6. WebSocket(Socket.IO)のイベント設計

$\color{red}{\text{方針: WebSocket は、サーバーからクライアントへの通知専用にする。書き込み(投稿・編集・既読など)は、すべて REST で行い、認可を REST に一本化する。クライアントからサーバーへ送るイベントは設けず、受信しても無視する。イベント名はコードで表記し、色は付けない。}}$

### 6.1 接続と認証

- $\color{red}{\text{トランスポートは websocket のみ(ポーリングへのフォールバックは使わない)。Origin の検証を、一か所で済ませるため。}}$
- $\color{red}{\text{ハンドシェイクで Origin を検証する。許可するオリジンと一致しない場合と、Origin ヘッダがない場合は、接続を拒否する(REST の CSRF 対策と同じ基準。§4.1)。}}$
- $\color{red}{\text{ハンドシェイクの Cookie からセッションを引き、有効でなければ拒否する(401 相当)。接続したソケットには、ユーザー ID とセッションのトークンのハッシュを持たせる。}}$
- $\color{red}{\text{1 ユーザーあたりの同時接続は 10 まで。超えた場合は、最も古い接続を切る。}}$
- $\color{red}{\text{1 つのソケットで、ユーザーが所属する全ワークスペースの通知を受ける(アカウントはグローバル。§9 #3)。ワークスペースごとに接続を分けない。}}$

### 6.2 ルーム

| ルーム | 参加者 | 用途 |
|---|---|---|
| `user:{userId}` | $\color{red}{\text{そのユーザーの全ソケット}}$ | $\color{red}{\text{本人宛の通知(メンション、既読の同期、所属の変化)}}$ |
| `session:{tokenHash}` | $\color{red}{\text{そのセッションのソケット}}$ | $\color{red}{\text{ログアウト時の切断}}$ |
| `ws:{workspaceId}` | $\color{red}{\text{そのワークスペースの active メンバーのソケット}}$ | $\color{red}{\text{メンバーの増減、パブリックチャンネルの作成・削除、プロフィールの変更}}$ |
| `ch:{channelId}` | $\color{red}{\text{そのチャンネルの参加者(ChannelMember)のソケット}}$ | $\color{red}{\text{メッセージ・スレッド・リアクションの通知}}$ |

$\color{red}{\text{接続時に、サーバーが、DB の Membership(active)と ChannelMember から、参加するルームを決めて、自分で参加させる。クライアントが、ルームを指定して参加する手段は設けない(任意のチャンネルを購読される恐れをなくすため)。参加させた後に、もう一度 DB を引いて、差分があれば補正する(接続中に所属が変わった場合に備える)。}}$

### 6.3 所属の変化に対するルームの更新

$\color{red}{\text{REST の処理が DB にコミットされた後に、同じリクエストの中で、ルームを更新して、通知を送る。ルームの更新は、通知の送信より先に行う(削除や追放の対象に、最後の通知が届かないようにするため)。}}$

| 契機 | ルームの更新 | 通知 |
|---|---|---|
| チャンネルへの参加・招待 | $\color{red}{\text{対象ユーザーの全ソケットを ch ルームに参加させる}}$ | `channel:added`(user ルームへ) |
| チャンネルからの退出 | $\color{red}{\text{対象ユーザーの全ソケットを ch ルームから外す}}$ | `channel:left`(user ルームへ)、`channel:member-left`(ch ルームへ) |
| チャンネルの削除 | $\color{red}{\text{全員を ch ルームから外す(通知の後)}}$ | `channel:deleted`(パブリックは ws ルームへ、プライベートと DM は ch ルームへ) |
| キック(FR-302) | $\color{red}{\text{対象ユーザーの全ソケットを、そのワークスペースの ws ルームと、そのワークスペースの全 ch ルームから外す。他のワークスペースのルームと、接続は維持する}}$ | `workspace:removed`(user ルームへ)、`member:removed`(ws ルームへ) |
| キック解除・再参加 | $\color{red}{\text{再参加の受諾(招待リンク)で、ws ルームと general の ch ルームに参加させる}}$ | `member:joined`(ws ルームへ) |
| パスワード再設定(FR-005) | $\color{red}{\text{そのユーザーの全ソケットを切断する(全セッションが削除されるため)}}$ | $\color{red}{\text{なし}}$ |
| ログアウト(FR-003) | $\color{red}{\text{そのセッションのソケットだけを切断する}}$ | $\color{red}{\text{なし}}$ |

$\color{red}{\text{セッションの期限切れ(30 日)は、接続を張ったまま超えた場合に備えて、1 時間ごとにソケットのセッションを DB で確認し、無効なら切断する。}}$

### 6.4 サーバーからクライアントへのイベント

$\color{red}{\text{ペイロードは、REST の応答と同じ形(メッセージなら、返信数・リアクション・添付つき)にする。削除済みのメッセージの本文は含めない。通知のペイロードに、受信者が閲覧権限を持たない情報を入れない。}}$

| イベント | 送信先 | 契機 | FR |
|---|---|---|---|
| `message:created` | $\color{red}{\text{ch ルーム}}$ | $\color{red}{\text{トップレベルのメッセージの投稿}}$ | 101 |
| `message:updated` | $\color{red}{\text{ch ルーム}}$ | $\color{red}{\text{本文の編集}}$ | 103 |
| `message:deleted` | $\color{red}{\text{ch ルーム}}$ | $\color{red}{\text{論理削除(ID とチャンネル ID のみ)}}$ | 104 |
| `thread:reply-created` | $\color{red}{\text{ch ルーム}}$ | $\color{red}{\text{返信の投稿(返信と、親の返信数を含む)}}$ | 105 |
| `thread:reply-updated`、`thread:reply-deleted` | $\color{red}{\text{ch ルーム}}$ | $\color{red}{\text{返信の編集・削除}}$ | 103, 104 |
| `reaction:added`、`reaction:removed` | $\color{red}{\text{ch ルーム}}$ | $\color{red}{\text{リアクションの付与・解除}}$ | 108 |
| `mention:created` | $\color{red}{\text{user ルーム(メンションされた人)}}$ | $\color{red}{\text{メンションつきの投稿・編集(新しく加わった人のみ)。メッセージの ID、チャンネル ID、ワークスペース ID を含む}}$ | 402 |
| `read:updated` | $\color{red}{\text{user ルーム}}$ | $\color{red}{\text{チャンネル・スレッドの既読位置の更新(別の端末・別のタブの表示を同期する)}}$ | 401 |
| `channel:created` | $\color{red}{\text{パブリックは ws ルーム、プライベートは作成者の user ルーム}}$ | $\color{red}{\text{チャンネルの作成}}$ | 202 |
| `channel:added`、`channel:left`、`channel:deleted`、`channel:member-left` | $\color{red}{\text{§6.3 のとおり}}$ | $\color{red}{\text{参加・退出・削除}}$ | 203, 204, 303 |
| `dm:created` | $\color{red}{\text{2 人の user ルーム}}$ | $\color{red}{\text{DM の作成(参加者の ch ルームへの参加も、この時に行う)}}$ | 102 |
| `member:joined`、`member:removed` | $\color{red}{\text{ws ルーム}}$ | $\color{red}{\text{招待の受諾・キック}}$ | 301, 302 |
| `workspace:removed` | $\color{red}{\text{user ルーム}}$ | $\color{red}{\text{キック(クライアントは、そのワークスペースの表示を閉じる)}}$ | 302 |
| `user:updated` | $\color{red}{\text{その人が active で所属する全ワークスペースの ws ルーム}}$ | $\color{red}{\text{表示名・アバター・ステータスの変更}}$ | 004 |

$\color{red}{\text{未読数・メンション数は、クライアントが、REST の初期値(GET /workspaces、GET /workspaces/:ws/channels)に、受信したイベントを加えて管理する。ミュート中のチャンネルの message:created は、未読に数えず、メンションは数える(FR-207、FR-403)。自分が投稿したメッセージは、未読に数えない。}}$

### 6.5 再接続と取りこぼし

- $\color{red}{\text{WebSocket は、切断中のイベントを保証しない。クライアントは、再接続したら、表示中のチャンネルと、未読数の元データを、REST で取り直す。}}$
- $\color{red}{\text{取りこぼしたメッセージを取るため、GET /channels/:ch/messages に、after パラメータ(指定した ID より新しいメッセージを、古い順に 50 件)を設ける。§3 のとおり、メッセージの採番はチャンネル単位の advisory lock でコミット順と一致しているため、「最後に受信した ID より新しい」で取りこぼしなく取れる。}}$
- $\color{red}{\text{Socket.IO の自動再接続を使う(間隔は、指数的に伸ばし、最大 30 秒)。ハートビートは Socket.IO の既定(25 秒)。}}$
- $\color{red}{\text{サーバーの再起動で、ルームの状態は失われる。クライアントが再接続し、接続時に §6.2 の手順でルームに参加し直す。}}$

### 6.6 テスト

$\color{red}{\text{結合テストで、次を確認する。(1) Origin がない・違う接続は拒否される。(2) セッションがない接続は拒否される。(3) 参加していないチャンネルのメッセージは届かない。(4) キックされたユーザーに、そのワークスペースのイベントが届かず、他のワークスペースのイベントは届き続ける。(5) チャンネルを退出・削除された後は、そのチャンネルのイベントが届かない。(6) パスワード再設定とログアウトで、該当のソケットが切断される。(7) 再接続後に、after パラメータで取りこぼしを取得できる。}}$

## 7. フェーズ 1 の実装タスク

$\color{red}{\text{対象は、FR-001〜004(登録・ログイン・ログアウト・プロフィール)と、基盤。あわせて、FR-005 のためのリカバリーコードの発行と保存(§9 #10)を行う。タスクは、上から順に、1 つずつ PR にする。各タスクの完了条件を満たし、CI が通ったら、次へ進む。}}$

| # | タスク | 完了条件 |
|---|---|---|
| T1 | $\color{red}{\text{リポジトリの雛形}}$ | $\color{red}{\text{pnpm ワークスペース(apps/web、apps/server、packages/shared)。TypeScript、ESLint、Prettier、Vitest の設定。.gitignore と、環境変数の例(.env.example)。pnpm install と pnpm test が、ルートで通る}}$ |
| T2 | $\color{red}{\text{CI}}$ | $\color{red}{\text{GitHub Actions で、lint、型チェック、テストを実行する(既存の claude 用のワークフローとは別のファイル)。PostgreSQL を、サービスコンテナで起動する}}$ |
| T3 | $\color{red}{\text{DB とマイグレーション}}$ | $\color{red}{\text{docker compose で PostgreSQL 16 を起動する。Drizzle で、§2 のスキーマのうち、users、sessions、workspaces、memberships(status を含む。要件定義書 §10.1 のとおり、Membership.status はフェーズ 1 で作る)、storage\_deletions を定義し、マイグレーションを生成する。マイグレーションの適用と、テスト用 DB の作成を、スクリプトにする。残りのテーブルは、使うフェーズで追加する。workspaces と memberships は、フェーズ 1 では API を作らない}}$ |
| T4 | $\color{red}{\text{サーバーの骨格}}$ | $\color{red}{\text{Fastify の起動、設定の読み込み、zod による検証、§4.3 のエラー形式、GET /health、Origin の検証(§4.1)、Cookie の設定、レート制限の仕組み(メモリ上。§4.1)、trustProxy の設定}}$ |
| T5 | $\color{red}{\text{登録・ログイン・ログアウト}}$ | $\color{red}{\text{POST /auth/register、/auth/login、/auth/logout と GET /me。argon2id、パスワードは 8 文字以上、ユーザー名の形式と大文字小文字を区別しない一意性(§1.1)、セッションの発行・検証・削除(30 日の固定期限)。リカバリーコードの発行(128 ビット以上のランダム値、ハッシュ化して保存、登録の応答で一度だけ返す)。ログイン失敗は、理由を特定しない同一の文言と、同等の処理時間(ダミーのハッシュ検証)}}$ |
| T6 | $\color{red}{\text{プロフィール}}$ | $\color{red}{\text{PATCH /me(表示名・ステータス。コードポイント数で検証)、PUT /me/avatar(2MB まで、jpg/png/gif/webp、マジックバイトで判定)、GET /users/:userId/avatar。ストレージのインターフェース(ローカルディスクの実装)。アバターの差し替え時は、同じトランザクションで、旧ファイルの storage\_key を storage\_deletions に積み、非同期で実体を削除して、失敗時は再試行する処理を、このタスクで作る。添付の行の削除でキューに積むトリガは、attachments のテーブルを作るフェーズ 4 で追加する}}$ |
| T7 | $\color{red}{\text{フロントの骨格}}$ | $\color{red}{\text{React + Vite、ルーティング、TanStack Query、API クライアント(エラー形式の処理)、ログイン済みか否かで画面を分ける。開発サーバーから API へのプロキシ(Cookie が同一オリジンで届くように)}}$ |
| T8 | $\color{red}{\text{認証・プロフィールの画面}}$ | $\color{red}{\text{登録(リカバリーコードを一度だけ表示し、保存したことの確認を求める)、ログイン、ログアウト、プロフィール設定(アバター・表示名・ステータス)}}$ |
| T9 | $\color{red}{\text{テストの整備}}$ | $\color{red}{\text{結合テスト(実 DB): 登録の重複(大文字小文字違い)、ログイン失敗の同一応答、セッションの期限切れ、ログアウト後のアクセス拒否、アバターの形式・サイズの境界(2MB ちょうどと +1)、旧アバターの削除キューへの登録と再試行。アバターの認可(同じワークスペースにいない相手は 404)は、ワークスペースを作るフェーズ 2 で追加する。Playwright で、登録からログアウトまでの流れを 1 本}}$ |

$\color{red}{\text{フェーズ 1 の完了条件: FR-001〜004 の受入基準を満たす(アバターの認可の部分は、フェーズ 2 で確認する)。リカバリーコードが、登録時に発行され、ハッシュで保存されている。CI が通る。}}$

## 8. 未決事項(設計)

| # | 論点 | 暫定案 |
|---|---|---|
| D1 | セッションの有効期限 | $\color{red}{\text{30 日。アクセスのたびに延長しない(固定期限)。30 日ごとに再ログインが必要になることを、仕様として受け入れる}}$ |
| D2 | 添付の保存先の構造 | $\color{red}{\text{storage\_key は、ワークスペース ID、日付、uuid の順のパスにする}}$ |
| D3 | メッセージ編集の履歴 | $\color{red}{\text{保存しない(edited\_at のみ)}}$ |
| D4 | 絵文字の種類 | $\color{red}{\text{Unicode 絵文字のみ(カスタム絵文字は対象外)}}$ |

$\color{red}{\text{D1〜D4 は暫定案。確定の連絡がなければ、この案で進める。}}$
