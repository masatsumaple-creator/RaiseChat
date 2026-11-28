import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { attachments, memberships, messages, storageDeletions } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage, type Storage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import {
  fileOfSize,
  JPEG_HEADER,
  makeTempDir,
  MP4_HEADER,
  multipart,
  PNG_HEADER,
  WEBM_HEADER,
  WEBP_HEADER,
  type MultipartPart,
} from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const MB = 1024 * 1024;

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let temp: Awaited<ReturnType<typeof makeTempDir>>;
let storage: LocalDiskStorage;
const apps: FastifyInstance[] = [];
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
  temp = await makeTempDir();
  storage = new LocalDiskStorage(temp.dir);
});

afterAll(async () => {
  await testDb.close();
  await temp.close();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(useStorage: Storage = storage) {
  const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
  const app = buildApp({ config, db: testDb.db, storage: useStorage, logger: false });
  apps.push(app);
  return app;
}

interface TestUser {
  username: string;
  token: string;
  id: string;
}

async function createUser(app: FastifyInstance): Promise<TestUser> {
  counter += 1;
  const username = `att_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.190.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  user: TestUser | undefined,
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN },
    cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/** multipart で投稿する */
function postForm(
  app: FastifyInstance,
  user: TestUser | undefined,
  ch: string,
  parts: MultipartPart[],
): Promise<LightMyRequestResponse> {
  const { payload, contentType } = multipart(parts);
  return app.inject({
    method: 'POST',
    url: `/api/channels/${ch}/messages`,
    headers: { origin: ORIGIN, 'content-type': contentType },
    cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
    payload,
  });
}

const file = (data: Buffer, filename = 'a.bin', contentType = 'application/octet-stream') =>
  ({ name: 'files', filename, contentType, data }) satisfies MultipartPart;
const bodyPart = (value: string) => ({ name: 'body', value }) satisfies MultipartPart;

const png = (size = 100) => fileOfSize(PNG_HEADER, size);
const mp4 = (size = 100) => fileOfSize(MP4_HEADER, size);
const webm = (size = 100) => fileOfSize(WEBM_HEADER, size);

async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const member = await createUser(app);
  const bystander = await createUser(app); // 同じワークスペースで、チャンネルに未参加
  const created = await send(app, 'POST', owner, '/api/workspaces', { name: 'チーム' });
  const ws = created.json().id as string;
  for (const u of [member, bystander]) {
    await testDb.db.insert(memberships).values({ workspaceId: ws, userId: u.id, role: 'member' });
  }
  const chRes = await send(app, 'POST', owner, `/api/workspaces/${ws}/channels`, {
    name: 'files',
    type: 'public',
  });
  const ch = chRes.json().id as string;
  expect((await send(app, 'POST', member, `/api/channels/${ch}/join`)).statusCode).toBe(200);
  return { app, owner, member, bystander, ws, ch };
}

async function attachmentRows(messageId: number) {
  return testDb.db.select().from(attachments).where(eq(attachments.messageId, messageId));
}

/** ワークスペースの添付の保存先に、ファイルがいくつあるか */
async function storedFileCount(ws: string): Promise<number> {
  const dir = path.join(temp.dir, 'attachments', ws);
  try {
    await stat(dir);
  } catch {
    return 0;
  }
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).length;
}

async function messageCount(ch: string) {
  const [row] = await testDb.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.channelId, ch));
  return row!.n;
}

describe('添付つきの投稿(FR-107)', () => {
  it('本文のみの JSON の投稿は、今までどおり(添付は空)', async () => {
    const { app, owner, ch } = await setup();
    const res = await send(app, 'POST', owner, `/api/channels/${ch}/messages`, { body: 'hello' });
    expect(res.statusCode).toBe(201);
    expect(res.json().attachments).toEqual([]);
  });

  it('画像と動画を添付できる。応答・一覧に、種類・MIME・サイズ・元のファイル名が、付けた順で入る', async () => {
    const { app, owner, ws, ch } = await setup();
    const image = png(1234);
    const video = mp4(5678);
    const res = await postForm(app, owner, ch, [
      bodyPart('写真と動画'),
      file(image, '写真.png', 'image/png'),
      file(video, 'clip.mp4', 'video/mp4'),
      file(webm(300), 'clip.webm', 'video/webm'),
    ]);
    expect(res.statusCode, res.body).toBe(201);
    const posted = res.json();
    expect(posted.body).toBe('写真と動画');
    expect(posted.attachments).toEqual([
      {
        id: expect.any(String),
        kind: 'image',
        mime: 'image/png',
        sizeBytes: 1234,
        name: '写真.png',
      },
      {
        id: expect.any(String),
        kind: 'video',
        mime: 'video/mp4',
        sizeBytes: 5678,
        name: 'clip.mp4',
      },
      {
        id: expect.any(String),
        kind: 'video',
        mime: 'video/webm',
        sizeBytes: 300,
        name: 'clip.webm',
      },
    ]);

    // DB の行と、ストレージの実体(ワークスペース ID・日付・uuid のパス)
    const rows = await attachmentRows(posted.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.storageKey).toMatch(
        new RegExp(`^attachments/${ws}/\\d{4}-\\d{2}-\\d{2}/${row.id}\\.(png|mp4|webm)$`),
      );
      expect(await storage.get(row.storageKey)).not.toBeNull();
    }
    expect(
      (await storage.get(rows.find((r) => r.kind === 'image')!.storageKey))!.equals(image),
    ).toBe(true);

    const list = await send(app, 'GET', owner, `/api/channels/${ch}/messages`);
    expect(list.json().messages[0].attachments).toEqual(posted.attachments);
  });

  it('形式は、拡張子や Content-Type ではなく、内容で判定する(偽装は拒否、正しい内容は、名前が違っても受け付ける)', async () => {
    const { app, owner, ws, ch } = await setup();
    const rejected: Array<[string, MultipartPart]> = [
      [
        'HTML を png と偽る',
        file(Buffer.from('<!doctype html><script>alert(1)</script>'), 'a.png', 'image/png'),
      ],
      [
        'SVG を png と偽る',
        file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'a.png', 'image/png'),
      ],
      [
        '実行ファイルを jpg と偽る',
        file(Buffer.from('MZ\u0090\u0000\u0003'), 'a.jpg', 'image/jpeg'),
      ],
      ['テキストを mp4 と偽る', file(Buffer.from('plain text, not a video'), 'a.mp4', 'video/mp4')],
      [
        'ftyp だが HEIC',
        file(
          Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]),
          'a.mp4',
          'video/mp4',
        ),
      ],
      ['空のファイル', file(Buffer.alloc(0), 'a.png', 'image/png')],
    ];
    for (const [label, part] of rejected) {
      const res = await postForm(app, owner, ch, [bodyPart('x'), part]);
      expect(res.statusCode, label).toBe(400);
      expect(res.json().code, label).toBe('unsupported_file');
    }
    expect(await messageCount(ch)).toBe(0);
    expect(await storedFileCount(ws)).toBe(0);

    // 内容が許可形式なら、拡張子や Content-Type が違っても、内容の形式で保存する
    const ok = await postForm(app, owner, ch, [
      bodyPart('内容で判定'),
      file(png(), 'noext', 'text/plain'),
      file(fileOfSize(JPEG_HEADER, 50), 'x.txt', 'application/octet-stream'),
      file(fileOfSize(WEBP_HEADER, 50), 'x.exe', 'application/x-msdownload'),
    ]);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().attachments.map((a: { mime: string }) => a.mime)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
  });

  it('1 つでも不正なら、投稿全体を拒否し、何も残さない(メッセージも、実体も)', async () => {
    const { app, owner, ws, ch } = await setup();
    const res = await postForm(app, owner, ch, [
      bodyPart('一部が不正'),
      file(png(), 'ok1.png'),
      file(mp4(), 'ok2.mp4'),
      file(Buffer.from('not media'), 'bad.png'),
    ]);
    expect(res.statusCode).toBe(400);
    expect(await messageCount(ch)).toBe(0);
    expect(await storedFileCount(ws)).toBe(0);
  });

  describe('サイズと数の上限(境界)', () => {
    it('画像: ちょうど 10MB は通り、10MB + 1 バイトは 413(何も残らない)', async () => {
      const { app, owner, ws, ch } = await setup();
      const exact = await postForm(app, owner, ch, [bodyPart('10MB'), file(png(10 * MB))]);
      expect(exact.statusCode, exact.body).toBe(201);
      expect(exact.json().attachments[0].sizeBytes).toBe(10 * MB);
      const before = await storedFileCount(ws);

      const over = await postForm(app, owner, ch, [bodyPart('超過'), file(png(10 * MB + 1))]);
      expect(over.statusCode).toBe(413);
      expect(over.json().code).toBe('payload_too_large');
      expect(await storedFileCount(ws)).toBe(before);
      expect(await messageCount(ch)).toBe(1);
    });

    it('動画: ちょうど 50MB は通り、50MB + 1 バイトは 413(何も残らない)。動画は、10MB を超えても通る', async () => {
      const { app, owner, ws, ch } = await setup();
      const exact = await postForm(app, owner, ch, [bodyPart('50MB'), file(mp4(50 * MB))]);
      expect(exact.statusCode, exact.body).toBe(201);
      expect(exact.json().attachments[0].sizeBytes).toBe(50 * MB);
      const before = await storedFileCount(ws);

      const over = await postForm(app, owner, ch, [bodyPart('超過'), file(webm(50 * MB + 1))]);
      expect(over.statusCode).toBe(413);
      expect(await storedFileCount(ws)).toBe(before);
      expect(await messageCount(ch)).toBe(1);
    });

    it('5 ファイルは通り、6 ファイルは 400(画像と動画の合計。何も残らない)', async () => {
      const { app, owner, ws, ch } = await setup();
      const five = await postForm(app, owner, ch, [
        bodyPart('5 つ'),
        file(png()),
        file(png()),
        file(mp4()),
        file(webm()),
        file(png()),
      ]);
      expect(five.statusCode, five.body).toBe(201);
      expect(five.json().attachments).toHaveLength(5);
      const before = await storedFileCount(ws);

      const six = await postForm(app, owner, ch, [
        bodyPart('6 つ'),
        ...Array.from({ length: 6 }, () => file(png())),
      ]);
      expect(six.statusCode).toBe(400);
      expect(six.json().code).toBe('too_many_files');
      expect(await storedFileCount(ws)).toBe(before);
      expect(await messageCount(ch)).toBe(1);
    });
  });

  it('本文は必須: 空白だけ・本文なしは、添付があっても 400(何も残らない)。本文の検証は、通常の投稿と同じ', async () => {
    const { app, owner, ws, ch } = await setup();
    for (const parts of [
      [bodyPart('   '), file(png())],
      [file(png())],
      [bodyPart('x'.repeat(4001)), file(png())],
    ]) {
      const res = await postForm(app, owner, ch, parts);
      expect(res.statusCode).toBe(400);
    }
    expect(await messageCount(ch)).toBe(0);
    expect(await storedFileCount(ws)).toBe(0);
  });

  it('フィールドの名前が違う・body が重複する・multipart でなく不正な形は、400', async () => {
    const { app, owner, ch } = await setup();
    const wrongFile = await postForm(app, owner, ch, [
      bodyPart('x'),
      { name: 'file', filename: 'a.png', data: png() },
    ]);
    expect(wrongFile.statusCode).toBe(400);
    const dupBody = await postForm(app, owner, ch, [bodyPart('a'), bodyPart('b'), file(png())]);
    expect(dupBody.statusCode).toBe(400);
    const unknown = await postForm(app, owner, ch, [bodyPart('a'), { name: 'other', value: 'x' }]);
    expect(unknown.statusCode).toBe(400);
    expect(await messageCount(ch)).toBe(0);
  });

  it('添付のないファイルなしの multipart は、通常の投稿として扱う', async () => {
    const { app, owner, ch } = await setup();
    const res = await postForm(app, owner, ch, [bodyPart('ファイルなし')]);
    expect(res.statusCode).toBe(201);
    expect(res.json().attachments).toEqual([]);
  });

  it('参加者でなければ 404、未ログインは 401(何も保存しない)', async () => {
    const { app, bystander, ws, ch } = await setup();
    const denied = await postForm(app, bystander, ch, [bodyPart('x'), file(png())]);
    expect(denied.statusCode).toBe(404);
    const anon = await postForm(app, undefined, ch, [bodyPart('x'), file(png())]);
    expect(anon.statusCode).toBe(401);
    expect(await storedFileCount(ws)).toBe(0);
    expect(await messageCount(ch)).toBe(0);
  });

  it('元のファイル名は、パスと制御文字を取り除いて、保存する(空なら file)', async () => {
    const { app, owner, ch } = await setup();
    const res = await postForm(app, owner, ch, [
      bodyPart('名前'),
      file(png(), '../../etc/passwd.png'),
      file(png(), 'C:\\Users\\x\\pic.png'),
      file(png(), '   '),
      file(png(), `${'あ'.repeat(300)}.png`),
    ]);
    expect(res.statusCode, res.body).toBe(201);
    const names = res.json().attachments.map((a: { name: string }) => a.name);
    expect(names.slice(0, 3)).toEqual(['passwd.png', 'pic.png', 'file']);
    expect([...names[3]].length).toBe(255);
  });

  it('DM でも、添付できる。参加者以外(オーナーを含む)は、投稿できない', async () => {
    const { app, owner, member, ws } = await setup();
    const third = await createUser(app);
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws, userId: third.id, role: 'member' });
    const dm = (
      await send(app, 'POST', member, `/api/workspaces/${ws}/dms`, { userId: third.id })
    ).json();
    const ok = await postForm(app, member, dm.id, [bodyPart('dm'), file(png())]);
    expect(ok.statusCode).toBe(201);
    const denied = await postForm(app, owner, dm.id, [bodyPart('dm'), file(png())]);
    expect(denied.statusCode).toBe(404);
  });
});

describe('添付と、編集・スレッド', () => {
  it('編集しても、添付は残り、応答に含まれる(本文が変わらない場合も)', async () => {
    const { app, owner, ch } = await setup();
    const posted = (await postForm(app, owner, ch, [bodyPart('元'), file(png(), 'a.png')])).json();
    const edited = await send(app, 'PATCH', owner, `/api/messages/${posted.id}`, {
      body: '直した',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().attachments).toEqual(posted.attachments);
    const same = await send(app, 'PATCH', owner, `/api/messages/${posted.id}`, { body: '直した' });
    expect(same.json().attachments).toEqual(posted.attachments);
  });

  it('スレッドの親の添付は、返信の一覧の親に含まれる。返信は、添付を持たない(JSON のみ)', async () => {
    const { app, owner, ch } = await setup();
    const posted = (await postForm(app, owner, ch, [bodyPart('親'), file(png())])).json();
    const reply = await send(app, 'POST', owner, `/api/messages/${posted.id}/replies`, {
      body: '返信',
    });
    expect(reply.json().attachments).toEqual([]);
    const page = (await send(app, 'GET', owner, `/api/messages/${posted.id}/replies`)).json();
    expect(page.parent.attachments).toEqual(posted.attachments);
    expect(page.replies[0].attachments).toEqual([]);
  });
});

describe('添付の削除(FR-104。実体の非同期削除)', () => {
  it('メッセージを削除すると、添付の行が消え(取得できない)、実体の削除が、キューに積まれ、実行される', async () => {
    const { app, owner, ch } = await setup();
    const posted = (
      await postForm(app, owner, ch, [bodyPart('消す'), file(png(), 'a.png'), file(mp4(), 'b.mp4')])
    ).json();
    const rows = await attachmentRows(posted.id);
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.storageKey);

    expect((await send(app, 'DELETE', owner, `/api/messages/${posted.id}`)).statusCode).toBe(204);
    expect(await attachmentRows(posted.id)).toEqual([]);
    // 削除のトランザクションで、削除キューに積まれている(トリガ)
    const queued = await testDb.db.select().from(storageDeletions);
    for (const key of keys) expect(queued.some((q) => q.storageKey === key)).toBe(true);
    // ワーカーの実行で、実体が消え、キューの行に deleted_at が付く
    await vi.waitFor(async () => {
      for (const key of keys) expect(await storage.get(key)).toBeNull();
      const after = await testDb.db.select().from(storageDeletions);
      for (const key of keys) {
        expect(after.find((q) => q.storageKey === key)!.deletedAt).not.toBeNull();
      }
    });
  });

  it('メッセージの行の削除(チャンネル削除の連鎖など)でも、添付の行が消え、実体の削除が、キューに積まれる', async () => {
    const { app, owner, ch } = await setup();
    const posted = (await postForm(app, owner, ch, [bodyPart('連鎖'), file(png())])).json();
    const [row] = await attachmentRows(posted.id);
    await testDb.db.execute(sql`DELETE FROM channels WHERE id = ${ch}`);
    expect(await attachmentRows(posted.id)).toEqual([]);
    const queued = await testDb.db.select().from(storageDeletions);
    expect(queued.some((q) => q.storageKey === row!.storageKey)).toBe(true);
  });

  it('実体の削除に失敗しても、キューの行が残り、次の実行で再試行される', async () => {
    const { owner, ch } = await setup();
    let failing = true;
    const flaky: Storage = {
      put: (key, data) => storage.put(key, data),
      get: (key) => storage.get(key),
      delete: async (key) => {
        if (failing) throw new Error('一時的な失敗');
        await storage.delete(key);
      },
    };
    const app = makeApp(flaky);
    const posted = (await postForm(app, owner, ch, [bodyPart('再試行'), file(png())])).json();
    const [row] = await attachmentRows(posted.id);
    await send(app, 'DELETE', owner, `/api/messages/${posted.id}`);
    await vi.waitFor(async () => {
      const [q] = await testDb.db
        .select()
        .from(storageDeletions)
        .where(eq(storageDeletions.storageKey, row!.storageKey));
      expect(q!.retryCount).toBeGreaterThan(0);
      expect(q!.deletedAt).toBeNull();
    });
    expect(await storage.get(row!.storageKey)).not.toBeNull();

    failing = false;
    const { processStorageDeletions } = await import('../storage/deletion-queue');
    await processStorageDeletions(testDb.db, flaky);
    expect(await storage.get(row!.storageKey)).toBeNull();
  });
});

describe('保存の途中の失敗', () => {
  it('実体の保存が途中で失敗したら、保存済みの分は、削除キューに積まれ、メッセージは作られない(500)', async () => {
    const { owner, ws, ch } = await setup();
    let puts = 0;
    const broken: Storage = {
      put: async (key, data) => {
        puts += 1;
        if (puts === 2) throw new Error('ディスクがいっぱい');
        await storage.put(key, data);
      },
      get: (key) => storage.get(key),
      delete: (key) => storage.delete(key),
    };
    const app = makeApp(broken);
    const res = await postForm(app, owner, ch, [
      bodyPart('失敗'),
      file(png(), 'a.png'),
      file(png(), 'b.png'),
    ]);
    expect(res.statusCode).toBe(500);
    expect(await messageCount(ch)).toBe(0);
    const queued = await testDb.db
      .select()
      .from(storageDeletions)
      .where(sql`${storageDeletions.storageKey} LIKE ${`attachments/${ws}/%`}`);
    expect(queued.length).toBeGreaterThanOrEqual(1);
    // 実行すると、保存された実体は、残らない
    const { processStorageDeletions } = await import('../storage/deletion-queue');
    await processStorageDeletions(testDb.db, storage);
    await vi.waitFor(async () => expect(await storedFileCount(ws)).toBe(0));
  });
});
