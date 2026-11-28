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
const threadOf = (page: Page) => page.getByRole('complementary', { name: 'スレッド' });

test('二人の画面で、スレッドの返信とリアクションが、リロードなしに反映される', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);

  // --- 準備: オーナーがワークスペースを作り、招待リンクで、ゲストが参加する ---
  const owner = await newPerson(browser);
  await register(owner, `tho_${suffix}`);
  await createWorkspace(owner, 'スレッドの部屋');
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  const invitePath = await issueInvitation(owner);
  const guest = await newPerson(browser);
  await guest.goto(invitePath);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await registerFromForm(guest, `thg_${suffix}`);
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();

  // --- 親の投稿 ---
  await sendMessage(owner, 'スレッドの親');
  const parentOf = (page: Page) =>
    messagesOf(page).getByRole('listitem').filter({ hasText: 'スレッドの親' });
  await expect(parentOf(guest)).toBeVisible();

  // --- ゲストがスレッドを開いて返信 → オーナーの一覧の返信数が増える ---
  await parentOf(guest).getByRole('button', { name: '返信', exact: true }).click();
  await expect(threadOf(guest)).toBeVisible();
  await threadOf(guest).getByRole('textbox', { name: '返信', exact: true }).fill('ゲストの返信');
  await threadOf(guest).getByRole('textbox', { name: '返信', exact: true }).press('Enter');
  await expect(threadOf(guest).getByText('ゲストの返信')).toBeVisible();
  await expect(parentOf(owner).getByRole('button', { name: '返信 1 件' })).toBeVisible();

  // --- オーナーがスレッドを開くと、返信が見え、そこで返信すると、ゲストのパネルに反映される ---
  await parentOf(owner).getByRole('button', { name: '返信 1 件' }).click();
  await expect(threadOf(owner).getByText('ゲストの返信')).toBeVisible();
  await threadOf(owner).getByRole('textbox', { name: '返信', exact: true }).fill('オーナーの返信');
  await threadOf(owner).getByRole('textbox', { name: '返信', exact: true }).press('Enter');
  await expect(threadOf(guest).getByText('オーナーの返信')).toBeVisible();
  await expect(parentOf(guest).getByRole('button', { name: '返信 2 件' })).toBeVisible();

  // --- 返信の編集・削除が、相手のパネルに反映される ---
  const ownReply = threadOf(owner).getByRole('listitem').filter({ hasText: 'オーナーの返信' });
  await ownReply.getByRole('button', { name: '編集' }).click();
  const editor = owner.getByLabel('メッセージを編集');
  await editor.fill('オーナーの返信(直した)');
  await editor.press('Enter');
  await expect(threadOf(guest).getByText('オーナーの返信(直した)')).toBeVisible();
  await ownReply.getByRole('button', { name: '削除' }).click();
  await ownReply.getByRole('button', { name: '削除する' }).click();
  await expect(threadOf(guest).getByText('オーナーの返信(直した)')).toHaveCount(0);
  await expect(parentOf(guest).getByRole('button', { name: '返信 1 件' })).toBeVisible();

  // --- リアクション: 付与が相手の画面に出る。自分のものは強調、相手の画面では強調されない ---
  await parentOf(guest).getByRole('button', { name: 'リアクションを追加' }).click();
  await parentOf(guest).getByRole('button', { name: '🎉', exact: true }).click();
  const chipOwner = parentOf(owner).getByRole('button', { name: '🎉 1' });
  await expect(chipOwner).toBeVisible();
  await expect(chipOwner).toHaveAttribute('aria-pressed', 'false');
  await expect(chipOwner).toHaveAttribute('title', `thg_${suffix}`);
  await expect(parentOf(guest).getByRole('button', { name: '🎉 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // オーナーも同じ絵文字を付けると、件数が 2 になる(ゲストの画面にも)
  await chipOwner.click();
  await expect(parentOf(guest).getByRole('button', { name: '🎉 2' })).toBeVisible();
  await expect(parentOf(owner).getByRole('button', { name: '🎉 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // スレッドの中の返信にも、リアクションを付けられ、相手のパネルに出る
  const guestReplyOwnerView = threadOf(owner)
    .getByRole('listitem')
    .filter({ hasText: 'ゲストの返信' });
  await guestReplyOwnerView.getByRole('button', { name: 'リアクションを追加' }).click();
  await guestReplyOwnerView.getByRole('button', { name: '👍', exact: true }).click();
  await expect(
    threadOf(guest).getByRole('listitem').filter({ hasText: 'ゲストの返信' }).getByRole('button', {
      name: '👍 1',
    }),
  ).toBeVisible();

  // 解除: 自分のリアクションをもう一度押すと、相手の画面でも件数が減る
  await parentOf(owner).getByRole('button', { name: '🎉 2' }).click();
  await expect(parentOf(guest).getByRole('button', { name: '🎉 1' })).toBeVisible();

  // --- 親を削除すると、「削除されました」と表示され、返信は残る(パネルからも開ける) ---
  await parentOf(owner).getByRole('button', { name: '削除', exact: true }).click();
  await parentOf(owner).getByRole('button', { name: '削除する' }).click();
  await expect(messagesOf(guest).getByText(/このメッセージは、削除されました。/)).toBeVisible();
  await expect(threadOf(guest).getByText(/このメッセージは、削除されました。/)).toBeVisible();
  await expect(threadOf(guest).getByText('ゲストの返信')).toBeVisible();
  await expect(threadOf(guest).getByRole('textbox', { name: '返信', exact: true })).toHaveCount(0);
});
