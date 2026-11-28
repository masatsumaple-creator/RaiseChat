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
const dmNavOf = (page: Page) => page.getByRole('navigation', { name: 'ダイレクトメッセージ' });

test('二人の画面で、メンションの補完と強調、DM の作成と送受信が、リロードなしに反映される', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const ownerName = `dmo_${suffix}`;
  const guestName = `dmg_${suffix}`;

  // --- 準備: オーナーがワークスペースを作り、招待リンクで、ゲストが参加する ---
  const owner = await newPerson(browser);
  await register(owner, ownerName);
  await createWorkspace(owner, 'DM の部屋');
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  const invitePath = await issueInvitation(owner);
  const guest = await newPerson(browser);
  await guest.goto(invitePath);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await registerFromForm(guest, guestName);
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();
  await owner
    .getByRole('navigation', { name: 'チャンネル' })
    .getByRole('link', { name: '# general' })
    .click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();

  // --- メンションの補完: 「@」の後ろで候補が出て、選ぶと、本文に入る ---
  const box = owner.getByRole('textbox', { name: 'メッセージ' });
  await box.fill('こんにちは @dmg');
  const option = owner.getByRole('option', { name: new RegExp(`@${guestName}`) });
  await expect(option).toBeVisible();
  await box.press('Enter'); // 候補の確定(送信ではない)
  await expect(box).toHaveValue(`こんにちは @${guestName} `);
  await expect(messagesOf(owner).getByText('こんにちは')).toHaveCount(0);
  await box.press('Enter');

  // --- 相手の画面で、メンションが強調される ---
  const mentionOf = (page: Page) =>
    messagesOf(page).getByRole('listitem').filter({ hasText: 'こんにちは' }).locator('.mention');
  await expect(mentionOf(guest)).toHaveText(`@${guestName}`);
  await expect(mentionOf(owner)).toHaveText(`@${guestName}`);

  // 存在しない名前は、強調されない
  await sendMessage(owner, '@nobody_here さん');
  await expect(messagesOf(guest).getByText('@nobody_here さん')).toBeVisible();
  await expect(
    messagesOf(guest).getByRole('listitem').filter({ hasText: 'nobody_here' }).locator('.mention'),
  ).toHaveCount(0);

  // --- DM: オーナーが、メンバー一覧から選んで始める ---
  await dmNavOf(owner).getByRole('link', { name: 'DM を始める' }).click();
  await owner.getByRole('button', { name: new RegExp(`\\(@${guestName}\\)`) }).click();
  await expect(owner.getByRole('heading', { name: new RegExp(`^@ `) })).toBeVisible();
  // 自分自身は、選べない
  await dmNavOf(owner).getByRole('link', { name: 'DM を始める' }).click();
  await expect(owner.getByRole('button', { name: new RegExp(`\\(@${ownerName}\\)`) })).toHaveCount(
    0,
  );
  await dmNavOf(owner).getByRole('link', { name: /^@ / }).click();

  // ゲストのサイドバーに、リロードなしで、DM が出る(相手の名前で)
  const guestDmLink = dmNavOf(guest).getByRole('link', { name: /^@ / });
  await expect(guestDmLink).toBeVisible();

  // --- DM の送受信: ゲストの画面に、リロードなしで届く ---
  await sendMessage(owner, 'こっそり、DM です');
  await guestDmLink.click();
  await expect(messagesOf(guest).getByText('こっそり、DM です')).toBeVisible();
  await sendMessage(guest, 'DM を受け取りました');
  await expect(messagesOf(owner).getByText('DM を受け取りました')).toBeVisible();

  // DM では、退出できない
  await expect(owner.getByRole('button', { name: '退出' })).toHaveCount(0);

  // 同じ相手に、もう一度 DM を始めても、同じ DM が開く(重複しない)
  await dmNavOf(owner).getByRole('link', { name: 'DM を始める' }).click();
  await owner.getByRole('button', { name: new RegExp(`\\(@${guestName}\\)`) }).click();
  await expect(messagesOf(owner).getByText('こっそり、DM です')).toBeVisible();
  await expect(dmNavOf(owner).getByRole('link', { name: /^@ / })).toHaveCount(1);
});
