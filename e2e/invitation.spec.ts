import { expect, test } from '@playwright/test';
import { newPerson, register, registerFromForm } from './helpers';

test('ワークスペースを作り、招待リンクで別の人が(未ログインから登録して)参加し、取り消すと無効になる', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const ownerName = `own_${suffix}`;
  const guestName = `gst_${suffix}`;
  const lateName = `lat_${suffix}`;

  // --- オーナー: 登録 → ワークスペースの作成 ---
  const owner = await newPerson(browser);
  await register(owner, ownerName);
  await expect(owner.getByRole('heading', { name: `ようこそ、${ownerName}さん` })).toBeVisible();
  await owner.getByLabel('ワークスペース名').fill('みんなの部屋');
  await owner.getByRole('button', { name: '作成' }).click();
  await expect(owner).toHaveURL(/\/w\/[0-9a-f-]{36}\/c\/[0-9a-f-]{36}$/); // general が開く
  await expect(owner.getByRole('heading', { name: 'みんなの部屋' })).toBeVisible();
  // 切り替えの一覧に、自分のワークスペースが出る
  await expect(
    owner
      .getByRole('navigation', { name: 'ワークスペース' })
      .getByRole('link', { name: 'みんなの部屋' }),
  ).toBeVisible();

  // --- オーナー: 招待リンクの発行(既定: 7 日・10 回) ---
  await owner.getByRole('link', { name: '招待リンクの管理' }).click();
  await owner.getByRole('button', { name: 'リンクを発行' }).click();
  const link = (await owner.getByTestId('issued-link').textContent())!;
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(owner.getByRole('cell', { name: '0 / 10' })).toBeVisible();

  // --- ゲスト: 未ログインでリンクを開く → ログイン画面(戻り先つき)→ 登録 → 招待の確認 → 参加 ---
  const guest = await newPerson(browser);
  await guest.goto(new URL(link).pathname);
  await expect(guest).toHaveURL(/\/login\?next=%2Finvite%2F/);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await expect(guest).toHaveURL(/\/register\?next=%2Finvite%2F/); // 戻り先を、引き継いでいる
  await registerFromForm(guest, guestName);
  await expect(guest.getByText('「みんなの部屋」に招待されています')).toBeVisible();
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest).toHaveURL(/\/w\/[0-9a-f-]{36}\/c\/[0-9a-f-]{36}$/);
  await expect(guest.getByRole('heading', { name: 'みんなの部屋' })).toBeVisible();
  await guest.getByRole('link', { name: 'メンバー' }).click();
  const members = guest.getByRole('list', { name: 'メンバー' });
  await expect(members.getByText(`@${ownerName}`)).toBeVisible();
  await expect(members.getByText(`@${guestName}`)).toBeVisible();
  // メンバーには、招待リンクの管理は、出ない
  await expect(guest.getByRole('link', { name: '招待リンクの管理' })).toHaveCount(0);

  // --- オーナー: 使用回数が増え、取り消すと、状態が変わる ---
  await owner.reload(); // 招待リンクの管理の画面のまま、最新の状態を取り直す
  await expect(owner.getByRole('cell', { name: '1 / 10' })).toBeVisible();
  await owner.getByRole('button', { name: '取り消す' }).click();
  await expect(owner.getByRole('cell', { name: '取り消し済み' })).toBeVisible();
  await expect(owner.getByRole('button', { name: '取り消す' })).toHaveCount(0);

  // --- 取り消し後に、リンクを開いた人は、参加できない ---
  const late = await newPerson(browser);
  await register(late, lateName);
  await late.goto(new URL(link).pathname);
  await expect(late.getByRole('alert')).toContainText('この招待リンクは、無効です');
  await expect(late.getByRole('button', { name: '参加する' })).toHaveCount(0);
});
