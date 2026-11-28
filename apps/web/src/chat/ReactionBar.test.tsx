// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { ReactionBar, reactorNames } from './ReactionBar';

afterEach(cleanup);

const names = new Map([
  ['u1', '太郎'],
  ['u2', '花子'],
]);

function setup(onToggle = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ReactionBar
      reactions={[
        { emoji: '👍', count: 2, userIds: ['u1', 'u2'] },
        { emoji: '🎉', count: 1, userIds: ['u2'] },
      ]}
      myId="u1"
      names={names}
      onToggle={onToggle}
    />,
  );
  return { onToggle };
}

describe('reactorNames', () => {
  it('付けた人の名前を並べる。名前が分からない人は出さない', () => {
    expect(reactorNames(['u1', 'u2'], names)).toBe('太郎、花子');
    expect(reactorNames(['u1', 'u9'], names)).toBe('太郎');
    expect(reactorNames([], names)).toBe('');
  });
});

describe('ReactionBar(FR-108)', () => {
  it('絵文字ごとの件数と、付けた人(title)を表示し、自分が付けたものを強調する(aria-pressed)', () => {
    setup();
    const thumbs = screen.getByRole('button', { name: '👍 2' });
    expect(thumbs.getAttribute('title')).toBe('太郎、花子');
    expect(thumbs.getAttribute('aria-pressed')).toBe('true');
    const party = screen.getByRole('button', { name: '🎉 1' });
    expect(party.getAttribute('title')).toBe('花子');
    expect(party.getAttribute('aria-pressed')).toBe('false');
  });

  it('自分が付けたものを押すと解除、付けていないものを押すと付与(mine で伝える)', async () => {
    const { onToggle } = setup();
    fireEvent.click(screen.getByRole('button', { name: '👍 2' }));
    fireEvent.click(screen.getByRole('button', { name: '🎉 1' }));
    await waitFor(() => expect(onToggle).toHaveBeenCalledTimes(2));
    expect(onToggle).toHaveBeenNthCalledWith(1, '👍', true);
    expect(onToggle).toHaveBeenNthCalledWith(2, '🎉', false);
  });

  it('「リアクションを追加」で絵文字を選ぶと、付与する。選ぶと、選択欄は閉じる', async () => {
    const { onToggle } = setup();
    expect(screen.queryByRole('group', { name: '絵文字を選ぶ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'リアクションを追加' }));
    fireEvent.click(screen.getByRole('button', { name: '🚀' }));
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith('🚀', false));
    expect(screen.queryByRole('group', { name: '絵文字を選ぶ' })).toBeNull();
  });

  it('選択欄から、すでに自分が付けた絵文字を選ぶと、解除になる', async () => {
    const { onToggle } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'リアクションを追加' }));
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith('👍', true));
  });

  it('失敗したら、エラーを示す', async () => {
    setup(vi.fn().mockRejectedValue(new ApiError(400, 'too_many_reactions', '種類が多すぎます')));
    fireEvent.click(screen.getByRole('button', { name: '🎉 1' }));
    expect((await screen.findByRole('alert')).textContent).toBe('種類が多すぎます');
  });
});
