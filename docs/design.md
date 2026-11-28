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

-- ユーザー(アカウントはグローバル。要件定義書 §9 #3)
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
  owner_role  text NOT NULL GENERATED ALWAYS AS ('owner') STORED,  -- 常に 'owner'。下の外部キー用
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_owner_id_idx ON workspaces (owner_id);

-- 所属。kicked の行は、キックから解除までの間だけ存在する(FR-302, 304)
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'kicked')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
-- オーナーは各ワークスペースに 1 人
CREATE UNIQUE INDEX memberships_one_owner_key ON memberships (workspace_id) WHERE role = 'owner';
CREATE UNIQUE INDEX memberships_workspace_user_role_key ON memberships (workspace_id, user_id, role);
-- workspaces.owner_id と、オーナーの行の一致を、DB で保証する。
-- ワークスペースと、オーナーの行は相互に参照するため、同じトランザクションで作り、検査はコミットまで遅らせる。
-- オーナーの行の削除・role の変更・別のユーザーへの付け替えと、owner_id の付け替えは、コミット時に拒否される。
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_owner_membership_fk
  FOREIGN KEY (id, owner_id, owner_role) REFERENCES memberships (workspace_id, user_id, role)
  DEFERRABLE INITIALLY DEFERRED;
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

-- スレッド単位の既読位置(要件定義書 §9 #13)。最初の返信時に親投稿者と返信者の分を作る
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

-- 添付実体の削除キュー(要件定義書 §9 #8)
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
- $\color{red}{\text{ワークスペースの削除は MVP 対象外(要件定義書 §9 #4)のため、ワークスペースから Membership・Invitation・Channel への連鎖は、将来のために設定してある。}}$
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
- $\color{red}{\text{レート制限(§1.1 のとおりメモリ上で管理し、超過は 429)の対象は、次のとおり。(1) 登録・ログイン・パスワード再設定。登録は、同一 IP から 15 分に 10 回まで。ログインは、同一 IP とユーザー名(大文字小文字を区別しない)の組で 15 分に 5 回、同一 IP 全体で 15 分に 30 回まで(FR-005 と同じ基準)。試行は、パスワードを確かめる前に数え(同時に送られた推測で、上限を超えないため)、組の分は、ログインに成功すると数え直す。再設定は FR-005 の基準に従う。(2) 招待リンクの確認と受諾。トークンが無効だった試行(存在しない・期限切れ・取り消し・回数超過・kicked を区別せず、すべて失敗として数える)だけを数え、ユーザー単位で 15 分に 10 回、同一 IP 全体で 15 分に 30 回とする。有効なリンクの利用は、数えない。トークンの総当たりと、有効性の探索を防ぐため。IP の取得元は、リバースプロキシの背後では、設定で指定した信頼するプロキシのアドレスから届いた X-Forwarded-For だけを使い(Fastify の trustProxy を、プロキシのアドレスに限定して設定する)、それ以外の経路では、ヘッダを無視して接続元のアドレスを使う(ヘッダの偽装で制限を回避されないため)。同じ NAT の内側の別のユーザーが、失敗を重ねると、IP 単位の上限に達して、正規のユーザーも 429 になり得るが、小規模の利用では許容する(15 分で解除される)。}}$

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
| `GET /channels/:ch/messages` | $\color{red}{\text{requireChannel}}$ | $\color{red}{\text{トップレベルのメッセージを新しい順に取得(返信数、リアクション、添付つき)。cursor で次のページ。再接続後は、パラメータなしで最新の 50 件を取り直して、置き換える(§6.5)}}$ | 101, 105 |
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
- $\color{red}{\text{1 つのソケットで、ユーザーが所属する全ワークスペースの通知を受ける(アカウントはグローバル。要件定義書 §9 #3)。ワークスペースごとに接続を分けない。}}$

### 6.2 ルーム

| ルーム | 参加者 | 用途 |
|---|---|---|
| `user:{userId}` | $\color{red}{\text{そのユーザーの全ソケット}}$ | $\color{red}{\text{本人宛の通知(メンション、既読の同期、所属の変化)}}$ |
| `session:{tokenHash}` | $\color{red}{\text{そのセッションのソケット}}$ | $\color{red}{\text{ログアウト時の切断}}$ |
| `ws:{workspaceId}` | $\color{red}{\text{そのワークスペースの active メンバーのソケット}}$ | $\color{red}{\text{メンバーの増減、パブリックチャンネルの作成・削除、プロフィールの変更}}$ |
| `ch:{channelId}` | $\color{red}{\text{そのチャンネルの参加者(ChannelMember)のソケット}}$ | $\color{red}{\text{メッセージ・スレッド・リアクションの通知}}$ |

$\color{red}{\text{接続時に、サーバーが、DB の Membership(active)と ChannelMember から、参加するルームを決めて、自分で参加させる。クライアントが、ルームを指定して参加する手段は設けない(任意のチャンネルを購読される恐れをなくすため)。参加させた後に、もう一度 DB を引いて、差分があれば補正する(接続中に所属が変わった場合に備える)。}}$

### 6.3 所属の変化に対するルームの更新

$\color{red}{\text{REST の処理が DB にコミットされた後に、同じリクエストの中で、ルームの更新と通知を行う。順序は、次の 2 種類で、表の「順序」の列に行ごとに示す。(a) 先に更新: 参加させる場合と、一部の人だけを外す場合。参加した人が通知を受け取れるよう、また、外された人に、その後の通知が届かないようにするため、先にルームを更新する。(b) 先に通知: 全員を外す場合(チャンネルの削除)。外した後では、誰にも通知が届かなくなるため、先に通知を送る。実装者は、一律に更新を先にしてはならない。}}$

| 契機 | 順序 | ルームの更新 | 通知 |
|---|---|---|---|
| ワークスペースの作成(FR-201) | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{作成者の全ソケットを、ws ルームと、general の ch ルームに参加させる}}$ | `workspace:added`(user ルームへ。別のタブの表示のため) |
| チャンネルの作成(FR-202) | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{作成者の全ソケットを、ch ルームに参加させる}}$ | `channel:created`(§6.4 のとおり) |
| チャンネルへの参加・招待 | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{対象ユーザーの全ソケットを、ch ルームに参加させる}}$ | `channel:added`(user ルームへ)、`channel:member-joined`(ch ルームへ) |
| チャンネルからの退出 | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{対象ユーザーの全ソケットを、ch ルームから外す}}$ | `channel:left`(user ルームへ)、`channel:member-left`(ch ルームへ。外した後なので、本人には届かない) |
| チャンネルの削除(FR-303) | $\color{red}{\text{先に通知}}$ | $\color{red}{\text{通知の後に、全員を ch ルームから外す}}$ | `channel:deleted`(パブリックは ws ルームへ、プライベートと DM は ch ルームへ) |
| DM の作成 | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{2 人の全ソケットを、ch ルームに参加させる}}$ | `dm:created`(2 人の user ルームへ) |
| 招待の受諾による参加・再参加(FR-301) | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{対象ユーザーの全ソケットを、ws ルームと、general の ch ルームに参加させる}}$ | `workspace:added`(user ルームへ)、`member:joined`(ws ルームへ) |
| キック(FR-302) | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{対象ユーザーの全ソケットを、そのワークスペースの ws ルームと、そのワークスペースの全 ch ルームから外す。他のワークスペースのルームと、接続は維持する}}$ | `workspace:removed`(user ルームへ)、`member:removed`(ws ルームへ)、`channel:member-left`(対象が参加していた各 ch ルームの、残りのメンバーへ) |
| キックの解除(FR-304) | $\color{red}{\text{なし}}$ | $\color{red}{\text{なし。解除しただけでは、参加しない。再参加は、新しい招待リンクの受諾(上の行)による。キック前に参加していたプライベートチャンネルには、自動では戻らず、再招待が必要(FR-204)}}$ | $\color{red}{\text{なし}}$ |
| パスワード再設定(FR-005) | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{そのユーザーの全ソケットを切断する(全セッションが削除されるため)}}$ | $\color{red}{\text{なし}}$ |
| ログアウト(FR-003) | $\color{red}{\text{先に更新}}$ | $\color{red}{\text{そのセッションのソケットだけを切断する}}$ | $\color{red}{\text{なし}}$ |

$\color{red}{\text{パブリックチャンネルの削除の通知は、ws ルームへ送るため、そのチャンネルに参加していないワークスペースのメンバーにも届く。これは意図したもので、未参加のパブリックチャンネルの一覧(FR-203)から、削除されたチャンネルを消すため。通知の後に外すのは、ch ルームだけでよい。}}$

$\color{red}{\text{DB のコミットと、ルームの更新の間に、プロセスが落ちた場合、ルームの状態が DB とずれる。落ちたプロセスは、接続も失うため、クライアントは再接続し、そのとき §6.2 の手順で、DB から、ルームに参加し直す。単一プロセスの小規模な構成では、これで足りるため、許容する。接続中に、プロセスが落ちずに、ルームの更新だけが失敗した場合は、更新の失敗を、エラーとしてログに出し、対象のソケットを切断して、再接続による補正に任せる。}}$

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
| `channel:added`、`channel:member-joined`、`channel:left`、`channel:member-left`、`channel:deleted` | $\color{red}{\text{§6.3 のとおり}}$ | $\color{red}{\text{参加・退出・キック・削除}}$ | 203, 204, 302, 303 |
| `workspace:added` | $\color{red}{\text{user ルーム}}$ | $\color{red}{\text{ワークスペースの作成、招待の受諾による参加(別のタブの表示に、ワークスペースを加える)}}$ | 201, 301 |
| `dm:created` | $\color{red}{\text{2 人の user ルーム}}$ | $\color{red}{\text{DM の作成(参加者の ch ルームへの参加も、この時に行う)}}$ | 102 |
| `member:joined`、`member:removed` | $\color{red}{\text{ws ルーム}}$ | $\color{red}{\text{招待の受諾・キック}}$ | 301, 302 |
| `workspace:removed` | $\color{red}{\text{user ルーム}}$ | $\color{red}{\text{キック(クライアントは、そのワークスペースの表示を閉じる)}}$ | 302 |
| `user:updated` | $\color{red}{\text{その人が active で所属する全ワークスペースの ws ルーム}}$ | $\color{red}{\text{表示名・アバター・ステータスの変更}}$ | 004 |

$\color{red}{\text{未読数・メンション数は、クライアントが、REST の初期値(GET /workspaces、GET /workspaces/:ws/channels)に、受信したイベントを加えて管理する。ミュート中のチャンネルの message:created は、未読に数えず、メンションは数える(FR-207、FR-403)。自分が投稿したメッセージは、未読に数えない。}}$

### 6.5 再接続と取りこぼし

- $\color{red}{\text{WebSocket は、切断中のイベントを保証しない。取りこぼしの補正は、REST で取り直して、置き換える方式にする(差分だけを取る専用のパラメータは設けない。仕組みを増やさず、編集・削除・リアクションの変化も、まとめて補正できるため)。}}$
- $\color{red}{\text{再接続したクライアントは、次の順で取り直す。(1) GET /workspaces と GET /workspaces/:ws/channels で、未読数・メンション数・チャンネル一覧を取り直し、置き換える。(2) 表示中のチャンネルは、GET /channels/:ch/messages(パラメータなし)で、最新の 50 件を取り直し、表示中の先頭の部分を置き換える。REST の応答には、返信数・リアクション・添付・編集と削除の状態が含まれるため、切断中の変化も、この 50 件の範囲では、補正される。(3) 取り直した 50 件より古い部分は、キャッシュを捨て、スクロールで、cursor により取り直す(古いメッセージの、切断中の編集は、取り直すまで反映されないが、許容する)。(4) スレッドのパネルを開いている場合は、GET /messages/:id/replies で、返信を先頭から取り直す(50 件を超える場合は、cursor で続きを取る)。}}$
- $\color{red}{\text{取り直しの間に届いたイベントは、メッセージの ID で、冪等に適用する(同じ ID は置き換える。削除済みは、削除を優先し、後から届いた古い更新で戻さない)。}}$
- $\color{red}{\text{§3 のとおり、メッセージの採番はチャンネル単位の advisory lock でコミット順と一致するため、最新の 50 件の取り直しで、順序が前後することはない。}}$
- $\color{red}{\text{Socket.IO の自動再接続を使う(間隔は、指数的に伸ばし、最大 30 秒)。ハートビートは Socket.IO の既定(25 秒)。}}$
- $\color{red}{\text{サーバーの再起動で、ルームの状態は失われる。クライアントが再接続し、接続時に §6.2 の手順でルームに参加し直す。}}$

### 6.6 テスト

$\color{red}{\text{結合テストで、次を確認する。(1) Origin がない・違う接続は拒否される。(2) セッションがない接続は拒否される。(3) 参加していないチャンネルのメッセージは届かない。(4) キックされたユーザーに、そのワークスペースのイベントが届かず、他のワークスペースのイベントは届き続ける。(5) チャンネルを退出・削除された後は、そのチャンネルのイベントが届かない。(6) パスワード再設定とログアウトで、該当のソケットが切断される。(7) 切断中に、投稿・編集・削除・リアクションがあっても、再接続後の取り直しで、最新の 50 件が正しく表示される。(8) チャンネルの削除の通知が、プライベートの参加者全員と、パブリックの ws ルーム全員に届く。(9) 作成者が、作成直後に、そのチャンネルのイベントを受け取る。}}$

### 6.7 実装するフェーズ

$\color{red}{\text{WebSocket は、メッセージの投稿(フェーズ 3)の前提になるため、基盤をフェーズ 2 で作り、イベントを、各フェーズで足す。}}$

| フェーズ | 実装する内容 |
|---|---|
| 2 | $\color{red}{\text{接続(Origin・セッションの確認、同時接続の上限、期限の確認)、ルームへの参加と補正(§6.2)、所属の変化に対するルームの更新(§6.3 のうち、ワークスペース・チャンネル・招待に関する行)、イベント: workspace:added、channel 系(channel:member-left を含む。退出の通知のため)、member:joined、user:updated、メッセージの投稿(FR-101)のための message:created、ログアウトでの切断(FR-003)。フェーズ 1 で作った PATCH /me と PUT /me/avatar のハンドラに、user:updated の送信処理を足す(ワークスペースがないフェーズ 1 では、送信先がないため、フェーズ 2 で足す)}}$ |
| 3 | $\color{red}{\text{message:updated、message:deleted、thread 系、reaction 系、mention:created、dm:created}}$ |
| 5 | $\color{red}{\text{キックに関する行(workspace:removed、member:removed、キック時の channel:member-left の送信。イベント自体はフェーズ 2 で作る)、read:updated}}$ |
| 6 | $\color{red}{\text{パスワード再設定での切断(FR-005)}}$ |

## 7. フェーズ 1 の実装タスク

$\color{red}{\text{対象は、FR-001〜004(登録・ログイン・ログアウト・プロフィール)と、基盤。あわせて、FR-005 のためのリカバリーコードの発行と保存(要件定義書 §9 #10)を行う。タスクは、上から順に、1 つずつ PR にする。各タスクの完了条件には、そのタスクの結合テスト(実 DB)を含め、テストなしでは、マージしない。CI が通ったら、次へ進む。}}$

| # | タスク | 完了条件 |
|---|---|---|
| T1 | $\color{red}{\text{リポジトリの雛形}}$ | $\color{red}{\text{pnpm ワークスペース(apps/web、apps/server、packages/shared)。TypeScript、ESLint、Prettier、Vitest の設定。.gitignore と、環境変数の例(.env.example)。pnpm install と pnpm test が、ルートで通る}}$ |
| T2 | $\color{red}{\text{CI}}$ | $\color{red}{\text{GitHub Actions で、lint、型チェック、テストを実行する(既存の claude 用のワークフローとは別のファイル)。PostgreSQL を、サービスコンテナで起動する}}$ |
| T3 | $\color{red}{\text{DB とマイグレーション}}$ | $\color{red}{\text{docker compose で PostgreSQL 16 を起動する。Drizzle で、§2 のスキーマのうち、users、sessions、workspaces、memberships(status を含む。要件定義書 §10.1 のとおり、Membership.status はフェーズ 1 で作る)、storage\_deletions を定義し、マイグレーションを生成する。マイグレーションの適用と、テスト用 DB の作成を、スクリプトにする。残りのテーブルは、使うフェーズで追加する。workspaces と memberships は、フェーズ 1 では API を作らない。テスト: マイグレーションを、空の DB に適用でき、制約(ユーザー名の大文字小文字を区別しない一意性、オーナーの一意性)が効くこと}}$ |
| T4 | $\color{red}{\text{サーバーの骨格}}$ | $\color{red}{\text{Fastify の起動、設定の読み込み、zod による検証(文字数は、コードポイント数。§1.1)、§4.3 のエラー形式、GET /health、Origin の検証(§4.1。欠落は拒否)、Cookie の設定、レート制限の仕組み(メモリ上。§4.1)、trustProxy の設定。テスト: Origin の欠落・不一致が 403、エラー形式、レート制限の超過が 429}}$ |
| T5 | $\color{red}{\text{セッションと登録}}$ | $\color{red}{\text{POST /auth/register と GET /me。argon2id、パスワードは 8 文字以上、ユーザー名の形式と大文字小文字を区別しない一意性(§1.1)。登録に成功すると、そのままログイン状態になり、セッションの Cookie を発行する(セッションは、トークンのハッシュを保存し、30 日の固定期限)。リカバリーコードの発行(128 ビット以上のランダム値、ハッシュ化して保存、登録の応答で一度だけ返す)。テスト: 登録の重複(大文字小文字違い)が拒否される、パスワードとリカバリーコードが平文で保存されていない、期限切れのセッションが 401、リカバリーコードが登録の応答にだけ含まれる}}$ |
| T6 | $\color{red}{\text{ログインとログアウト}}$ | $\color{red}{\text{POST /auth/login と POST /auth/logout。ログイン失敗は、理由を特定しない同一の文言と、同等の処理時間(存在しないユーザー名でも、ダミーのハッシュ検証を行う)。ログインの試行は、レート制限をかける。ログアウトは、そのセッションだけを削除する。テスト: 存在しないユーザーと誤ったパスワードの応答が同一、ログアウト後に同じ Cookie で 401、他のセッションは残る}}$ |
| T7 | $\color{red}{\text{プロフィール}}$ | $\color{red}{\text{PATCH /me(表示名・ステータス。コードポイント数で検証)、PUT /me/avatar(2MB まで、jpg/png/gif/webp、マジックバイトで判定)、GET /users/:userId/avatar(フェーズ 1 では、本人のみ。他のユーザーは、ワークスペースを作るフェーズ 2 で、共通の所属の条件(§5.1)を加える)。ストレージのインターフェース(ローカルディスクの実装)。アバターの差し替え時は、同じトランザクションで、旧ファイルの storage\_key を storage\_deletions に積み、非同期で実体を削除して、失敗時は再試行する処理を、このタスクで作る。添付の行の削除でキューに積むトリガは、attachments のテーブルを作るフェーズ 4 で追加する。テスト: 2MB ちょうどと +1、拡張子を偽ったファイルの拒否、旧アバターの削除キューへの登録と再試行}}$ |
| T8 | $\color{red}{\text{フロントの骨格}}$ | $\color{red}{\text{React + Vite、ルーティング、TanStack Query、API クライアント(エラー形式の処理)、ログイン済みか否かで画面を分ける。開発サーバーから API へのプロキシ(Cookie が同一オリジンで届くように)。テスト: API クライアントのエラー処理の単体テスト}}$ |
| T9 | $\color{red}{\text{認証・プロフィールの画面}}$ | $\color{red}{\text{登録(リカバリーコードを一度だけ表示し、保存したことの確認を求める)、ログイン、ログアウト、プロフィール設定(アバター・表示名・ステータス)。テスト: Playwright で、登録からログアウトまでの流れを 1 本}}$ |

$\color{red}{\text{フェーズ 1 の完了条件: FR-001〜004 の受入基準を満たす(アバターの他ユーザーへの認可は、フェーズ 2 で確認する)。リカバリーコードが、登録時に発行され、ハッシュで保存されている。ただし、リカバリーコードを使った再設定の手段(POST /auth/recover。FR-005)は、フェーズ 6 で作るため、フェーズ 1 の時点では、パスワードを忘れた場合に、再設定する手段がない。これを、フェーズ 1 の範囲として許容する(要件定義書 §9 #10)。CI が通る。}}$

## 8. 未決事項(設計)

| # | 論点 | 暫定案 |
|---|---|---|
| D1 | セッションの有効期限 | $\color{red}{\text{30 日。アクセスのたびに延長しない(固定期限)。30 日ごとに再ログインが必要になることを、仕様として受け入れる}}$ |
| D2 | 添付の保存先の構造 | $\color{red}{\text{storage\_key は、ワークスペース ID、日付、uuid の順のパスにする}}$ |
| D3 | メッセージ編集の履歴 | $\color{red}{\text{保存しない(edited\_at のみ)}}$ |
| D4 | 絵文字の種類 | $\color{red}{\text{Unicode 絵文字のみ(カスタム絵文字は対象外)}}$ |

$\color{red}{\text{D1〜D4 は暫定案。確定の連絡がなければ、この案で進める。}}$

## 9. フェーズ 2 の実装タスク

$\color{red}{\text{対象は、FR-101、201〜204、206、301 と、WebSocket の基盤(§6.7 のフェーズ 2)。あわせて、フェーズ 1 で持ち越した、他のユーザーのアバターの認可(共通の所属の条件。§5.1)を行う。進め方は、§7 と同じ(上から順に、1 つずつ PR。各タスクの完了条件には、そのタスクの結合テスト(実 DB)を含め、テストなしでは、マージしない)。使うテーブルは、使うタスクで追加する。}}$

| # | タスク | 完了条件 |
|---|---|---|
| T10 | $\color{red}{\text{ワークスペースとガード}}$ | $\color{red}{\text{channels、channel\_members のテーブルを追加する(§2)。requireMember、requireOwner(§4.1)。POST /workspaces(作成者がオーナーになり、general(既定チャンネル)と、作成者のその参加が、同じトランザクションで作られる)、GET /workspaces、GET /workspaces/:ws、GET /workspaces/:ws/members。GET /users/:userId/avatar に、同じワークスペースの active なメンバーであるという条件を加える(本人は、これまでどおり)。テスト: オーナーの一意性、作成の原子性(general がない状態が残らない)、kicked は 403・非所属は 404、他ワークスペースのメンバーのアバターは 404、同じワークスペースなら取得できる}}$ |
| T11 | $\color{red}{\text{チャンネル}}$ | $\color{red}{\text{requireChannel。POST /workspaces/:ws/channels(名前は、同一ワークスペース内で一意。大文字小文字を区別しない)、GET /workspaces/:ws/channels(参加中と、query での未参加のパブリック一覧)、GET /workspaces/:ws/channels/admin(プライベートは名前のみ)、POST /channels/:ch/join、POST /channels/:ch/leave、GET /channels/:ch/members、POST /channels/:ch/members(§4.4 の判定順序のとおり)。テスト: §4.4 の表の各行(404・403・400 の順序)、general は退出できない、プライベートは非参加者の一覧・join に現れない、オーナーが自分自身を追加できない、同名の同時作成で 1 件だけ成功する}}$ |
| T12 | $\color{red}{\text{招待リンク}}$ | $\color{red}{\text{invitations のテーブルを追加する。POST/GET/DELETE /workspaces/:ws/invitations、GET /invitations/:token、POST /invitations/:token/accept(§3.1 の手順)。トークンは、ハッシュで保存し、発行の応答でだけ返す。使用回数は、条件付き更新で原子的に消費する。受諾時に、general への参加も同じトランザクションで行う。kicked の再参加は拒否し、他の失敗と区別しない(同じ 404・同じ文言)。無効なトークンの試行は、レート制限の対象(§4.1)。テスト: 同時受諾が max\_uses を超えない、期限切れ・取り消し・回数超過・kicked が同一の応答、参加済みの再受諾は成功、トークンが平文で保存されていない、レート制限の超過が 429}}$ |
| T13 | $\color{red}{\text{メッセージの投稿と取得}}$ | $\color{red}{\text{messages のテーブルを追加する(フェーズ 2 で使う列のみ。スレッド・編集・削除の列は、フェーズ 3 で追加)。POST /channels/:ch/messages(本文は、コードポイント数で検証。参加者のみ)、GET /channels/:ch/messages(新しい順のカーソル方式のページング)。非参加者には 404(§4.4)。テスト: 投稿と取得、ページングの境界(件数ちょうど・次のページなし)、非参加者・他ワークスペースが 404、本文の長さの上限}}$ |
| T14 | $\color{red}{\text{WebSocket の基盤}}$ | $\color{red}{\text{Socket.IO の接続(Origin・セッションの確認、同時接続の上限、期限の確認)、ルームへの参加と補正(§6.2)、所属の変化に対するルームの更新(§6.3 のうち、ワークスペース・チャンネル・招待に関する行)、イベント: workspace:added、channel 系(channel:member-left を含む)、member:joined、message:created、user:updated(PATCH /me と PUT /me/avatar のハンドラに、送信処理を足す)、ログアウトでの切断(FR-003)。テスト: Origin 不一致・未ログインの接続が拒否される、参加していないチャンネルのイベントが届かない、ログアウトで切断される、投稿が別クライアントに届く、leave 後にイベントが届かない}}$ |
| T15 | $\color{red}{\text{画面: ワークスペース}}$ | $\color{red}{\text{ワークスペースの作成、一覧と切り替え(FR-206)、招待リンクの発行・一覧・取り消し(オーナーのみ)、招待リンクの受諾画面(未ログインなら、ログインまたは登録の後に、受諾へ戻る)。テスト: 画面の部品の単体テスト(切り替え、受諾後の遷移)}}$ |
| T16 | $\color{red}{\text{画面: チャンネルとチャット}}$ | $\color{red}{\text{チャンネル一覧(参加中・未参加のパブリック)、作成、参加・退出、プライベートへの招待、メッセージの表示と投稿、WebSocket での即時表示(再接続時の補正を含む)。テスト: Playwright で、2 人のユーザーが、招待リンクで同じワークスペースに入り、一方の投稿が、他方の画面にリロードなしで表示される流れを 1 本}}$ |

$\color{red}{\text{フェーズ 2 の完了条件: FR-101、201〜204、206、301 の受入基準を満たす(キックに関する検証は、フェーズ 5)。投稿が、他のクライアントに、通常 1 秒以内に表示される(計測は、ローカルの E2E で、おおよそで確認する)。アバターが、共通の所属のあるユーザーにだけ、取得できる。CI が通る。}}$

## 10. フェーズ 3 の実装タスク

$\color{red}{\text{対象は、FR-102(DM)、103(編集)、104(削除)、105(スレッド)、106(マークダウン)、108(リアクション)、109(メンション)。進め方は、§7、§9 と同じ(上から順に、1 つずつ PR。各タスクの完了条件には、そのタスクの結合テスト(実 DB)を含め、テストなしでは、マージしない)。使うテーブル・列は、使うタスクで追加する。WebSocket のイベントは、§6.4 のうち、フェーズ 3 の分(message:updated、message:deleted、thread 系、reaction 系、mention:created、dm:created)を、各タスクで足す。}}$

| # | タスク | 完了条件 |
|---|---|---|
| T17 | $\color{red}{\text{メッセージの拡張・編集・削除}}$ | $\color{red}{\text{messages に parent\_id、edited\_at、deleted\_at を足し、body を null にできるようにする(§2 のとおり。CHECK、UNIQUE (id, channel\_id)、親と同じチャンネルを保証する複合外部キー、トップレベルと返信の索引)。requireAuthor(§4.1)。PATCH /messages/:id(本文の編集。edited\_at を設定。本文が変わらない場合は、何もせず成功)、DELETE /messages/:id(論理削除。本文を null にして deleted\_at を設定)。判定の順序は §4.1 のとおり(存在しない・参加者でない → 404、削除済み → 404(投稿者以外にも 404)、投稿者以外 → 403)。メッセージの応答に edited\_at と返信数(replyCount。削除済みの返信は数えない。返信を作る API は T18 のため、T17 の時点では、テストで DB に直接作った返信で確かめる)を加える。GET /channels/:ch/messages は、トップレベルだけを返し、削除済みのトップレベルは、返信数が 1 以上のときだけ、本文と投稿者を含まない形(ID・チャンネル ID・作成日時・削除済みの印・返信数)で返す(返信数が 0 なら除外する。削除済みの返信しかない場合も除外する。FR-104、105)。この返信数があるため、画面は、「削除されました」と表示した親から、スレッドを開ける(T23)。イベントは、対象で使い分け、どちらか一方だけを送る(二重に送らない): トップレベルのメッセージなら message:updated、message:deleted(削除は、ID・チャンネル ID・返信数のみ)、返信なら thread:reply-updated(REST の応答と同じ形)、thread:reply-deleted(ID・チャンネル ID・親の ID・親の返信数のみ)。テスト: 投稿者だけが編集・削除でき、他の参加者は 403、非参加者は 404、削除済みへの編集・再削除は 404、削除後に DB の body が null、一覧・API・イベントに本文が出ない、本文の検証は投稿と同じ、同時の編集と削除で矛盾が残らない、編集・削除のイベントが参加者にだけ届く、トップレベルでは message:* だけ・返信では thread:reply-* だけが届く(二重に届かない)、削除済みの親(返信あり)が一覧に残り、返信数を含む}}$ |
| T18 | $\color{red}{\text{スレッド返信}}$ | $\color{red}{\text{thread\_members のテーブルを足す。POST /messages/:id/replies(親はトップレベルのみ。返信への返信は 400。親が削除済みなら 404。返信の投稿者と、親の投稿者を、ThreadMember にする)、GET /messages/:id/replies(古い順。cursor。削除済みの親でも、返信は取得できる)。メッセージの応答に、返信数(削除済みの返信は数えない)を加える。返信の編集・削除は、T17 の API を使い(返信は、一覧に出ない)、そのイベント(thread:reply-updated、thread:reply-deleted。トップレベルの message:* は送らない)も T17 で実装済みのため、T18 では、投稿のイベント thread:reply-created(返信と、親の返信数。ch ルームへ)だけを足す。テスト: 返信数の増減、親の削除後も返信が読める、返信への返信が 400、親と違うチャンネルに返信を作れない(DB の制約)、非参加者は 404、同時に返信しても ID の順とコミット順が一致する(チャンネル単位の advisory lock を、返信にも使う)}}$ |
| T19 | $\color{red}{\text{リアクション}}$ | $\color{red}{\text{reactions のテーブルを足す。PUT /messages/:id/reactions/:emoji(付与。すでにあれば成功)、DELETE(自分のリアクションの解除。冪等)。emoji は、パスにパーセントエンコードして指定し、Unicode 絵文字 1 つ(肌色・ZWJ・国旗・キーキャップを含む 1 つの書記素)だけを許す。文字列や、複数の絵文字は 400。1 つのメッセージに付けられる絵文字の種類は 20 までとし、超えたら 400(同時に付与されても超えないよう、メッセージの行をロックして数える)。削除済みへの付与は 404(§4.1)。メッセージの応答に、絵文字ごとの件数と付与者の一覧を加える。イベント: reaction:added、reaction:removed。テスト: 冪等な付与・解除、同時の付与で重複せず、種類の上限(20)も超えない、絵文字の検証(通常・肌色・ZWJ・国旗・文字・複数・空・長すぎる)、種類の上限、削除済みへの解除が成功、削除でリアクションが消える、非参加者は 404}}$ |
| T20 | $\color{red}{\text{メンション}}$ | $\color{red}{\text{mentions のテーブルを足す。投稿・編集の本文から、アットマークとユーザー名(大文字小文字を区別しない)を取り出し、そのチャンネルの参加者に当てはまる分だけ登録する(§5.6)。参加者でない名前・自分自身は、登録しない。コードのブロック・インラインコードの中は、解析しない。編集では、差分だけを更新し、新しく加わった人にだけ通知する。削除で、メンションを無効にする。メッセージの応答に、有効なメンション(ユーザー ID とユーザー名)を加える。イベント: mention:created(メンションされた人の user ルームへ。メッセージ ID、チャンネル ID、ワークスペース ID を含む)。テスト: 参加者だけが登録される(プライベートで非参加者をメンションしても、通知されず、チャンネルにも入れない)、編集の差分(追加・削除・変化なし)、コード内は対象外、大文字小文字、同じ人を複数回メンションしても 1 件、削除で消える、通知が本人にだけ届く}}$ |
| T21 | $\color{red}{\text{ダイレクトメッセージ}}$ | $\color{red}{\text{POST /workspaces/:ws/dms(相手のユーザー ID。同じワークスペースの active メンバーのみ。自分自身・kicked・他のワークスペースのユーザーは 400。すでにあれば、それを返す。dm\_key で重複を防ぎ、同時に作っても 1 つになる)。2 人の ChannelMember を、作成時に作る。チャンネル一覧に DM を含め、相手の情報(ID・表示名・アバター)を加える。DM の参加者以外には 404(存在を隠す)。退出・招待・削除はできない(§4.4)。イベント: dm:created(2 人の user ルームへ。2 人の全ソケットを、ch ルームに参加させる)。テスト: 同時作成で 1 つ、相手の検証、非参加者(オーナーを含む)は 404、DM の投稿・編集・削除・スレッド・リアクションが、チャンネルと同じ規則で動く、DM の作成通知}}$ |
| T22 | $\color{red}{\text{画面: マークダウン・編集・削除}}$ | $\color{red}{\text{本文を、react-markdown と rehype-sanitize で整形表示する(太字・斜体・取り消し線・インラインコード・コードブロック・リスト・引用・リンク。生の HTML は描画しない。リンクは、新しいタブで、noopener noreferrer を付けて開く。javascript: などのスキームは、リンクにしない)。自分のメッセージの編集(入力欄に戻して保存)と削除(確認つき)。「編集済み」と「削除されました」の表示。message:updated・message:deleted の反映。テスト: 整形の単体テスト(各記法)、XSS の試し(script、イベント属性、javascript:、img の onerror、iframe)が無害化される、編集・削除の操作と、他の人の画面への反映(E2E)}}$ |
| T23 | $\color{red}{\text{画面: スレッドとリアクション}}$ | $\color{red}{\text{メッセージの返信数と、スレッドのパネル(返信の一覧・投稿・編集・削除。親が削除済みなら「削除されました」と表示して、返信は残す)。リアクション(絵文字の選択・付与・解除、絵文字ごとの件数と付与者の表示。自分が付けたものは強調)。thread 系・reaction 系のイベントの反映。テスト: パネルとリアクションの部品の単体テスト、二人の画面で、返信とリアクションが、リロードなしに反映される(E2E)}}$ |
| T24 | $\color{red}{\text{画面: メンションと DM}}$ | $\color{red}{\text{入力中に、アットマークの後ろで、そのチャンネルの参加者を候補に出して補完する(GET /channels/:ch/members?q=)。本文の中の有効なメンションを強調して表示する。DM の作成(メンバー一覧から選ぶ)と、サイドバーの DM 一覧(相手の名前)、DM の画面。mention:created・dm:created の反映。テスト: 補完の部品の単体テスト(候補の絞り込み・選択・変換中の扱い)、二人の画面で、DM の送受信と、メンションの強調が、リロードなしに反映される(E2E)}}$ |

$\color{red}{\text{フェーズ 3 の完了条件: FR-102、103、104、105、106、108、109 の受入基準を満たす(添付に関する基準は、フェーズ 4)。メンションの通知の数え方(未読・メンション数)は、フェーズ 5。HTML の無害化のテストが通る。CI が通る。}}$
