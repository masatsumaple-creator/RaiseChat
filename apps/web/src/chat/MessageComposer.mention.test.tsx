// @vitest-environment jsdom
import type { ChannelMemberResponse } from '@raisechat/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageComposer } from './MessageComposer';

afterEach(cleanup);

const member = (id: string, username: string, displayName: string): ChannelMemberResponse => ({
  id,
  username,
  displayName,
  statusText: '',
  avatarUrl: null,
});
const ALL = [member('1', 'alice', 'アリス'), member('2', 'albert', 'アルバート')];

function setup(
  fetchCandidates = vi.fn(async (q: string) => ALL.filter((m) => m.username.startsWith(q))),
) {
  const onSend = vi.fn().mockResolvedValue(undefined);
  render(<MessageComposer onSend={onSend} fetchCandidates={fetchCandidates} />);
  const textarea = screen.getByLabelText('メッセージ') as HTMLTextAreaElement;
  /** 入力して、カーソルを末尾に置く */
  function type(value: string) {
    fireEvent.change(textarea, { target: { value, selectionStart: value.length } });
    textarea.setSelectionRange(value.length, value.length);
    fireEvent.select(textarea);
  }
  return { onSend, fetchCandidates, textarea, type };
}

describe('メンションの補完(FR-109)', () => {
  it('アットマークの後ろで、候補を出す。入力で絞り込む(絞り込みは、サーバーへの問い合わせ)', async () => {
    const { fetchCandidates, type } = setup();
    type('@');
    const list = await screen.findByRole('listbox', { name: 'メンションの候補' });
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(fetchCandidates).toHaveBeenLastCalledWith('');
    type('@alb');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(fetchCandidates).toHaveBeenLastCalledWith('alb');
    expect(screen.getByRole('option').textContent).toBe('アルバート(@albert)');
  });

  it('アットマークがない・メールアドレス・名前の後ろに空白があるときは、候補を出さない(問い合わせもしない)', async () => {
    const { fetchCandidates, type } = setup();
    type('hello');
    type('bob@exam');
    type('@alice ');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(fetchCandidates).not.toHaveBeenCalled();
  });

  it('候補を押す(マウス)と、「@ユーザー名 」に置き換わり、送信はしない', async () => {
    const { onSend, textarea, type } = setup();
    type('こんにちは @al');
    fireEvent.mouseDown(await screen.findByText('アリス(@alice)'));
    expect(textarea.value).toBe('こんにちは @alice ');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('↑↓ で選び、Enter で確定する(候補が開いている間、Enter は送信しない)', async () => {
    const { onSend, textarea, type } = setup();
    type('@al');
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' }); // 先頭から、末尾へ回る
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('@albert ');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Tab でも確定できる。Escape で閉じると、Enter は、通常どおり送信する', async () => {
    const { onSend, textarea, type } = setup();
    type('@al');
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('@alice ');

    type('@alice @al');
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@alice @al'));
  });

  it('日本語入力の変換中の Enter では、候補を確定せず、送信もしない', async () => {
    const { onSend, textarea, type } = setup();
    type('@al');
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(textarea.value).toBe('@al');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('候補がない(0 件)ときは、リストを出さず、Enter は、通常どおり送信する', async () => {
    const { onSend, textarea, type } = setup(vi.fn().mockResolvedValue([]));
    type('@zzz');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@zzz'));
  });

  it('候補の取得に失敗しても、入力はできて、候補は出ない', async () => {
    const { textarea, type } = setup(vi.fn().mockRejectedValue(new Error('x')));
    type('@al');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea.value).toBe('@al');
  });
});
