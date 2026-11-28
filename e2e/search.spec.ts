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
const resultsOf = (page: Page) => page.getByRole('list', { name: '検索結果' });

async function search(page: Page, q: string) {
  await page.getByLabel('メッセージを検索').fill(q);
  await page.getByRole('button', { name: '検索' }).click();
}

test('二人の画面で、投稿を検索して見つけられ、削除すると見つからなくなる。権限のない投稿は出ない', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const word = `みかん${suffix}`;

  // --- 準備: オーナーがワークスペースを作り、招待リンクで、ゲストが参加する ---
  const owner = await newPerson(browser);
  await register(owner, `sro_${suffix}`);
  await createWorkspace(owner, '検索の部屋');
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  const invitePath = await issueInvitation(owner);
  const guest = await newPerson(browser);
  await guest.goto(invitePath);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await registerFromForm(guest, `srg_${suffix}`);
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();

  // --- オーナーだけのプライベートチャンネルに、同じ語を含む投稿 ---
  await owner.getByRole('link', { name: 'チャンネルを作成' }).click();
  await owner.getByLabel('チャンネル名').fill('ないしょ');
  await owner.getByLabel('種類').selectOption('private');
  await owner.getByRole('button', { name: '作成' }).click();
  await expect(owner.getByRole('heading', { name: '🔒 ないしょ' })).toBeVisible();
  await sendMessage(owner, `ひみつの ${word} です`);
  await expect(messagesOf(owner).getByText(`ひみつの ${word} です`)).toBeVisible();

  // --- general に、投稿と、スレッドの返信 ---
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  await sendMessage(owner, `公開の ${word} です`);
  const parent = messagesOf(guest).getByRole('listitem').filter({ hasText: '公開の' });
  await expect(parent).toBeVisible();
  await parent.getByRole('button', { name: '返信', exact: true }).click();
  const panel = guest.getByRole('complementary', { name: 'スレッド' });
  await panel.getByRole('textbox', { name: '返信', exact: true }).fill(`返信にも ${word}`);
  await panel.getByRole('textbox', { name: '返信', exact: true }).press('Enter');
  await expect(panel.getByText(`返信にも ${word}`)).toBeVisible();

  // --- ゲストが検索: 参加している general の 2 件(返信と投稿。新しい順)だけ。プライベートは出ない ---
  await search(guest, word);
  await expect(guest).toHaveURL(/\/search\?q=/);
  const guestResults = resultsOf(guest).getByRole('listitem');
  await expect(guestResults).toHaveCount(2);
  await expect(guestResults.nth(0)).toContainText('(スレッドの返信)');
  await expect(guestResults.nth(1)).toContainText(`公開の ${word} です`);
  await expect(guestResults.nth(1)).toContainText('# general');
  // 一致した語は、強調される
  await expect(guestResults.nth(1).locator('mark')).toHaveText(word);
  await expect(resultsOf(guest).getByText('ひみつの')).toHaveCount(0);

  // --- オーナーが検索: 参加しているプライベートも、結果に入る(3 件) ---
  await search(owner, word);
  await expect(resultsOf(owner).getByRole('listitem')).toHaveCount(3);
  await expect(resultsOf(owner).getByText(/ひみつの/)).toBeVisible();
  await expect(resultsOf(owner).getByText('🔒 ないしょ')).toBeVisible();

  // --- 結果を押すと、そのチャンネルへ。返信の結果は、スレッドのパネルが開く ---
  await guestResults.nth(0).getByRole('link').click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(guest.getByRole('complementary', { name: 'スレッド' })).toBeVisible();
  await expect(
    guest.getByRole('complementary', { name: 'スレッド' }).getByText(`返信にも ${word}`),
  ).toBeVisible();

  // --- 1 文字は、検索せず、案内が出る ---
  await search(guest, 'み');
  await expect(guest.getByText('検索語は、2 文字以上で入力してください。')).toBeVisible();

  // --- 日本語の 2 文字でも、見つかる ---
  await search(guest, 'みか');
  await expect(resultsOf(guest).getByRole('listitem').first()).toBeVisible();

  // --- オーナーが、公開の投稿を削除すると、検索で見つからなくなる ---
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  const own = messagesOf(owner).getByRole('listitem').filter({ hasText: '公開の' });
  await own.getByRole('button', { name: '削除', exact: true }).click();
  await own.getByRole('button', { name: '削除する' }).click();
  await expect(own).toHaveCount(0);
  await search(guest, `公開の ${word}`);
  await expect(guest.getByText(/に一致するメッセージは、見つかりませんでした/)).toBeVisible();
});
