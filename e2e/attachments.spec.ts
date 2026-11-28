import { expect, test, type Page } from '@playwright/test';
import {
  createWorkspace,
  issueInvitation,
  newPerson,
  register,
  registerFromForm,
  sendMessage,
} from './helpers';

const messagesOf = (page: Page) => page.getByRole('list', { name: 'メッセージ一覧' });

/** 1x1 の、有効な PNG(ブラウザが、実際に描画できる) */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** MP4 の、先頭の部分(サーバーは、内容の先頭で形式を判定する。再生の可否は、ここでは問わない) */
const MP4_HEAD = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.alloc(2000, 0),
]);

test('画像と動画の添付が、リロードなしに、相手の画面で表示・再生でき、削除で消える', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);

  // --- 準備: オーナーがワークスペースを作り、招待リンクで、ゲストが参加する ---
  const owner = await newPerson(browser);
  await register(owner, `ato_${suffix}`);
  await createWorkspace(owner, '添付の部屋');
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  const invitePath = await issueInvitation(owner);
  const guest = await newPerson(browser);
  await guest.goto(invitePath);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await registerFromForm(guest, `atg_${suffix}`);
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();

  // --- 事前の確認: 許可形式でないファイルは、加えられず、理由が出る ---
  const picker = owner.getByLabel('ファイルを添付');
  await picker.setInputFiles({
    name: 'bad.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(owner.getByRole('alert', { name: '添付できなかったファイル' })).toContainText(
    'bad.svg',
  );
  await expect(owner.getByRole('list', { name: '添付するファイル' })).toHaveCount(0);

  // --- 6 つ目は、加えられない(5 つまで) ---
  await picker.setInputFiles(
    Array.from({ length: 6 }, (_, i) => ({
      name: `p${i}.png`,
      mimeType: 'image/png',
      buffer: PNG_1X1,
    })),
  );
  await expect(
    owner.getByRole('list', { name: '添付するファイル' }).getByRole('listitem'),
  ).toHaveCount(5);
  await expect(owner.getByRole('alert', { name: '添付できなかったファイル' })).toContainText(
    'p5.png',
  );
  // 取り消して、画像 1 つと動画 1 つにする
  for (const name of ['p1.png', 'p2.png', 'p3.png', 'p4.png']) {
    await owner.getByRole('button', { name: `${name} を取り消す` }).click();
  }
  await picker.setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4_HEAD });
  await expect(
    owner.getByRole('list', { name: '添付するファイル' }).getByRole('listitem'),
  ).toHaveCount(2);

  // --- 送信: 相手の画面に、画像のプレビューと、動画のプレイヤーが、リロードなしで出る ---
  await sendMessage(owner, '写真と動画です');
  const itemOf = (page: Page) =>
    messagesOf(page).getByRole('listitem').filter({ hasText: '写真と動画です' });
  await expect(itemOf(guest)).toBeVisible();
  const image = itemOf(guest).getByRole('img', { name: 'p0.png' });
  await expect(image).toBeVisible();
  // 実際に読み込まれて、描画されている(認可つきの取得が成功している)
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(1);
  const video = itemOf(guest).locator('video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('controls', '');
  const src = (await video.getAttribute('src'))!;
  const fetched = await guest.request.get(src);
  expect(fetched.status()).toBe(200);
  expect(fetched.headers()['content-type']).toBe('video/mp4');
  expect(fetched.headers()['x-content-type-options']).toBe('nosniff');
  const partial = await guest.request.get(src, { headers: { range: 'bytes=0-9' } });
  expect(partial.status()).toBe(206);

  // 送信したあとは、入力欄と、選んだファイルが、空になる
  await expect(owner.getByRole('list', { name: '添付するファイル' })).toHaveCount(0);

  // --- 画像を押すと、拡大して表示する ---
  await itemOf(guest).getByRole('button', { name: 'p0.png を拡大' }).click();
  await expect(guest.getByRole('dialog', { name: 'p0.png の拡大' })).toBeVisible();
  await guest.keyboard.press('Escape');
  await expect(guest.getByRole('dialog')).toHaveCount(0);

  // --- 削除すると、相手の画面から消え、添付の URL は、取得できなくなる ---
  const own = itemOf(owner);
  await own.getByRole('button', { name: '削除', exact: true }).click();
  await own.getByRole('button', { name: '削除する' }).click();
  await expect(itemOf(guest)).toHaveCount(0);
  const gone = await guest.request.get(src);
  expect(gone.status()).toBe(404);
});
