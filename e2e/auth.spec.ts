import { expect, test } from '@playwright/test';

// 1x1 の PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('登録 → リカバリーコードの確認 → プロフィール変更 → ログアウト → 再ログイン', async ({
  page,
}) => {
  const username = `e2e_${Date.now().toString(36)}`;
  const password = 'correct-horse-battery';

  // 未ログインで、ホームを開くと、ログイン画面へ移る
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  // 登録。画面が切り替わるのを待ってから入力する
  // (ログイン画面にも同じラベルの欄があり、切り替わる前に入力すると、そちらに入ってしまう)
  await page.getByRole('link', { name: '新規登録' }).click();
  await expect(page.getByRole('heading', { name: 'アカウント登録' })).toBeVisible();
  await page.getByLabel('ユーザー名').fill(username);
  await page.getByLabel(/^パスワード/).fill(password);
  await page.getByRole('button', { name: '登録' }).click();

  // リカバリーコードが表示される。保存の確認をするまで、先へ進めない
  await expect(
    page.getByRole('heading', { name: 'リカバリーコードを保存してください' }),
  ).toBeVisible();
  await expect(page.getByTestId('recovery-code')).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/);
  const proceed = page.getByRole('button', { name: '続ける' });
  await expect(proceed).toBeDisabled();

  // 画面に戻ってきた(再取得が走る)だけでは、コードの画面から動かない
  // (再取得の応答が返り、画面に反映される時間を待ってから、確かめる)
  const refetched = page.waitForResponse((r) => r.url().endsWith('/api/me'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  expect((await refetched).status()).toBe(200);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('recovery-code')).toBeVisible();

  await page.getByLabel('リカバリーコードを保存しました').check();
  await proceed.click();
  await expect(page.getByRole('heading', { name: `ようこそ、${username}さん` })).toBeVisible();

  // プロフィール: 表示名・ステータス・アイコン
  await page.getByRole('link', { name: username }).click();
  await expect(page.getByRole('heading', { name: 'プロフィール' })).toBeVisible();
  await page.getByLabel('表示名').fill('テスト太郎');
  await page.getByLabel('ステータス').fill('作業中');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('status')).toHaveText('保存しました。');
  await expect(page.getByRole('link', { name: 'テスト太郎' })).toBeVisible();

  await page.getByLabel(/画像を選ぶ/).setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  const avatar = page.getByAltText('現在のアイコン');
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute('src', /^\/api\/users\/.+\/avatar\?v=/);
  // 画像が、実際に取得できている
  await expect
    .poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  // ログアウト → ログイン画面。ログアウト後は、ホームを開けない
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  // 誤ったパスワードでは、ログインできない
  await page.getByLabel('ユーザー名').fill(username);
  await page.getByLabel('パスワード').fill('wrong-password-0');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'ユーザー名またはパスワードが正しくありません',
  );

  // 正しいパスワードで、再ログイン。変更したプロフィールが残っている
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('heading', { name: 'ようこそ、テスト太郎さん' })).toBeVisible();
});
