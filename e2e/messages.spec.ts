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

test('マークダウンの整形・XSS の無害化・編集・削除が、相手の画面に、リロードなしで反映される', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);

  // --- 準備: オーナーがワークスペースを作り、招待リンクで、ゲストが参加する ---
  const owner = await newPerson(browser);
  await register(owner, `mdo_${suffix}`);
  await createWorkspace(owner, '整形の部屋');
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  const invitePath = await issueInvitation(owner);
  const guest = await newPerson(browser);
  await guest.goto(invitePath);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await registerFromForm(guest, `mdg_${suffix}`);
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();

  // --- マークダウンの整形(相手の画面) ---
  await sendMessage(owner, '**太字** と `code` と [リンク](https://example.com/)');
  const item = messagesOf(guest).getByRole('listitem').filter({ hasText: '太字' });
  await expect(item.locator('.markdown strong')).toHaveText('太字');
  await expect(item.locator('code')).toHaveText('code');
  const link = item.getByRole('link', { name: 'リンク' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  // --- XSS の試し: 実行されず、要素にもならない ---
  const dialogs: string[] = [];
  guest.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await sendMessage(
    owner,
    '<img src=x onerror="alert(1)"> <script>alert(2)</script> [悪意](javascript:alert(3))',
  );
  const evil = messagesOf(guest).getByRole('listitem').filter({ hasText: '悪意' });
  await expect(evil).toBeVisible();
  await expect(evil.locator('img, script, a')).toHaveCount(0);
  await guest.waitForTimeout(300);
  expect(dialogs).toEqual([]);

  // --- 編集: 相手の画面に、本文と「編集済み」が反映される ---
  await sendMessage(owner, '直す前');
  await expect(messagesOf(guest).getByText('直す前')).toBeVisible();
  // 相手のメッセージには、編集・削除の操作が出ない
  await expect(
    messagesOf(guest)
      .getByRole('listitem')
      .filter({ hasText: '直す前' })
      .getByRole('button', { name: /^(編集|削除)$/ }),
  ).toHaveCount(0);
  const mine = messagesOf(owner).getByRole('listitem').filter({ hasText: '直す前' });
  await mine.getByRole('button', { name: '編集' }).click();
  const editor = owner.getByLabel('メッセージを編集');
  await expect(editor).toHaveValue('直す前');
  await editor.fill('直した後');
  await editor.press('Enter');
  await expect(messagesOf(owner).getByText('直した後')).toBeVisible();
  await expect(messagesOf(guest).getByText('直した後')).toBeVisible();
  await expect(messagesOf(guest).getByText('直す前')).toHaveCount(0);
  await expect(
    messagesOf(guest).getByRole('listitem').filter({ hasText: '直した後' }).getByText('(編集済み)'),
  ).toBeVisible();

  // --- 削除(確認つき): 相手の画面からも消える ---
  const target = messagesOf(owner).getByRole('listitem').filter({ hasText: '直した後' });
  await target.getByRole('button', { name: '削除' }).click();
  await target.getByRole('button', { name: 'キャンセル' }).click();
  await expect(messagesOf(guest).getByText('直した後')).toBeVisible(); // キャンセルでは消えない
  await target.getByRole('button', { name: '削除' }).click();
  await target.getByRole('button', { name: '削除する' }).click();
  await expect(messagesOf(owner).getByText('直した後')).toHaveCount(0);
  await expect(messagesOf(guest).getByText('直した後')).toHaveCount(0);
});
