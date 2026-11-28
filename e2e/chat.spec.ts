import { expect, test } from '@playwright/test';
import {
  createWorkspace,
  issueInvitation,
  newPerson,
  register,
  registerFromForm,
  sendMessage,
} from './helpers';

test('二人が同じワークスペースで、リロードなしに、投稿・チャンネルの作成・招待・参加が、相手の画面に反映される', async ({
  browser,
}) => {
  const suffix = Date.now().toString(36);
  const channelsOf = (page: import('@playwright/test').Page) =>
    page.getByRole('navigation', { name: 'チャンネル' });
  const messagesOf = (page: import('@playwright/test').Page) =>
    page.getByRole('list', { name: 'メッセージ一覧' });

  // --- 準備: オーナーがワークスペースを作り、招待リンクで、ゲストが参加する ---
  const owner = await newPerson(browser);
  await register(owner, `own_${suffix}`);
  await createWorkspace(owner, 'チャット部屋');
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible(); // general が開く
  const invitePath = await issueInvitation(owner);

  const guest = await newPerson(browser);
  await guest.goto(invitePath);
  await expect(guest).toHaveURL(/\/login\?next=/);
  await guest.getByRole('link', { name: '新規登録' }).click();
  await registerFromForm(guest, `gst_${suffix}`);
  await guest.getByRole('button', { name: '参加する' }).click();
  await expect(guest.getByRole('heading', { name: '# general' })).toBeVisible();

  // オーナーは、招待管理の画面から、general に戻る
  await channelsOf(owner).getByRole('link', { name: '# general' }).click();
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();

  // --- 投稿が、相手の画面に、リロードなしで表示される(FR-101。1 秒以内が目標) ---
  const started = Date.now();
  await sendMessage(owner, 'こんにちは、ゲストさん');
  await expect(messagesOf(guest).getByText('こんにちは、ゲストさん')).toBeVisible();
  const elapsed = Date.now() - started;
  expect(elapsed, `投稿から相手の画面に表示されるまで ${elapsed}ms`).toBeLessThan(2000);
  // 自分の画面にも出て、入力欄は空になる
  await expect(messagesOf(owner).getByText('こんにちは、ゲストさん')).toBeVisible();
  await expect(owner.getByRole('textbox', { name: 'メッセージ' })).toHaveValue('');

  await sendMessage(guest, 'はじめまして');
  await expect(messagesOf(owner).getByText('はじめまして')).toBeVisible();
  // 同じ投稿が、重ねて表示されない(応答とイベントの両方で届いても、1 件)
  await expect(messagesOf(owner).getByText('はじめまして')).toHaveCount(1);
  await expect(messagesOf(guest).getByText('はじめまして')).toHaveCount(1);

  // Shift+Enter は改行(送信しない)
  const box = owner.getByRole('textbox', { name: 'メッセージ' });
  await box.fill('一行目');
  await box.press('Shift+Enter');
  await box.pressSequentially('二行目');
  await expect(messagesOf(guest).getByText('二行目')).toHaveCount(0);
  await box.press('Enter');
  await expect(messagesOf(guest).getByText('一行目')).toBeVisible();

  // --- プライベートチャンネル: 作成者だけに見え、招待すると、相手の一覧に現れる ---
  await owner.getByRole('link', { name: 'チャンネルを作成' }).click();
  await owner.getByLabel('チャンネル名').fill('ひみつ');
  await owner.getByLabel('種類').selectOption('private');
  await owner.getByRole('button', { name: '作成' }).click();
  await expect(owner.getByRole('heading', { name: '🔒 ひみつ' })).toBeVisible();
  await expect(channelsOf(owner).getByRole('link', { name: '🔒 ひみつ' })).toBeVisible();
  // 招待していないゲストには、見えない
  await guest.waitForTimeout(500);
  await expect(channelsOf(guest).getByRole('link', { name: '🔒 ひみつ' })).toHaveCount(0);

  await owner.getByText(/^参加者/).click();
  await owner.getByLabel('招待する人').selectOption({ label: `gst_${suffix}(@gst_${suffix})` });
  await owner.getByRole('button', { name: '招待' }).click();
  await expect(channelsOf(guest).getByRole('link', { name: '🔒 ひみつ' })).toBeVisible();
  await channelsOf(guest).getByRole('link', { name: '🔒 ひみつ' }).click();
  await sendMessage(owner, 'ここだけの話');
  await expect(messagesOf(guest).getByText('ここだけの話')).toBeVisible();

  // --- パブリックチャンネル: 作成すると、ワークスペースの全員の「探す」に現れ、参加できる ---
  await guest.getByRole('link', { name: 'チャンネルを作成' }).click();
  await guest.getByLabel('チャンネル名').fill('雑談');
  await guest.getByRole('button', { name: '作成' }).click();
  await expect(guest.getByRole('heading', { name: '# 雑談' })).toBeVisible();

  await owner.getByRole('link', { name: 'チャンネルを探す' }).click();
  await expect(
    owner.getByRole('list', { name: '参加できるチャンネル' }).getByText('# 雑談'),
  ).toBeVisible();
  await owner.getByRole('button', { name: '参加' }).click();
  await expect(owner.getByRole('heading', { name: '# 雑談' })).toBeVisible();
  await sendMessage(guest, '雑談スタート');
  await expect(messagesOf(owner).getByText('雑談スタート')).toBeVisible();

  // --- 退出: 一覧から消え、以後の投稿は届かない。general は退出できない ---
  await owner.getByRole('button', { name: '退出' }).click();
  await expect(channelsOf(owner).getByRole('link', { name: '# 雑談' })).toHaveCount(0);
  await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(owner.getByRole('button', { name: '退出' })).toHaveCount(0);

  // --- リロードしても、履歴が残っている(REST で取り直される) ---
  await guest.reload();
  await guest.getByRole('link', { name: '# general' }).click();
  await expect(messagesOf(guest).getByText('こんにちは、ゲストさん')).toBeVisible();
  await expect(messagesOf(guest).getByText('はじめまして')).toBeVisible();
});
