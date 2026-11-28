import { expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery';

/** 新しいブラウザ(Cookie を共有しない別の人)のページを作る */
export async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

/** 登録の画面で、登録して、リカバリーコードの確認を済ませる(戻り先があれば、そこへ移る) */
export async function registerFromForm(page: Page, username: string) {
  await expect(page.getByRole('heading', { name: 'アカウント登録' })).toBeVisible();
  await page.getByLabel('ユーザー名').fill(username);
  await page.getByLabel(/^パスワード/).fill(PASSWORD);
  await page.getByRole('button', { name: '登録' }).click();
  await expect(
    page.getByRole('heading', { name: 'リカバリーコードを保存してください' }),
  ).toBeVisible();
  await page.getByLabel('リカバリーコードを保存しました').check();
  await page.getByRole('button', { name: '続ける' }).click();
}

export async function register(page: Page, username: string) {
  await page.goto('/register');
  await registerFromForm(page, username);
}

/** ワークスペースを作る(ホームの作成フォームから)。作成後は、general が開く */
export async function createWorkspace(page: Page, name: string) {
  await page.getByLabel('ワークスペース名').fill(name);
  await page.getByRole('button', { name: '作成' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** 招待リンクを発行して、そのパスを返す(オーナーの画面から) */
export async function issueInvitation(page: Page): Promise<string> {
  await page.getByRole('link', { name: '招待リンクの管理' }).click();
  await page.getByRole('button', { name: 'リンクを発行' }).click();
  const link = (await page.getByTestId('issued-link').textContent())!;
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  return new URL(link).pathname;
}

/** メッセージを投稿する(入力欄に入力して、Enter) */
export async function sendMessage(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'メッセージ' });
  await box.fill(text);
  await box.press('Enter');
}
