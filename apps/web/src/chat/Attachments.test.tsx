// @vitest-environment jsdom
import type { AttachmentResponse } from '@raisechat/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Attachments } from './Attachments';

afterEach(cleanup);

const image = (id: string, name = `${id}.png`): AttachmentResponse => ({
  id,
  kind: 'image',
  mime: 'image/png',
  sizeBytes: 2048,
  name,
});
const video = (id: string, name = `${id}.mp4`): AttachmentResponse => ({
  id,
  kind: 'video',
  mime: 'video/mp4',
  sizeBytes: 5 * 1024 * 1024,
  name,
});

describe('Attachments(FR-107)', () => {
  it('添付がなければ、何も出さない', () => {
    const { container } = render(<Attachments attachments={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('画像はプレビュー(同じオリジンの URL)、動画は再生できる(controls)。名前とサイズも出す', () => {
    render(<Attachments attachments={[image('i1', '写真.png'), video('v1', 'clip.mp4')]} />);
    const list = screen.getByRole('list', { name: '添付' });
    const img = within(list).getByRole('img', { name: '写真.png' });
    expect(img.getAttribute('src')).toBe('/api/attachments/i1');
    const vid = list.querySelector('video')!;
    expect(vid.getAttribute('src')).toBe('/api/attachments/v1');
    expect(vid.hasAttribute('controls')).toBe(true);
    expect(within(list).getByText('写真.png(2.0 KB)')).toBeTruthy();
    expect(within(list).getByText('clip.mp4(5.0 MB)')).toBeTruthy();
  });

  it('複数の添付を、付けた順に並べる', () => {
    render(<Attachments attachments={[image('a'), video('b'), image('c')]} />);
    const items = within(screen.getByRole('list', { name: '添付' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('a.png'),
      expect.stringContaining('b.mp4'),
      expect.stringContaining('c.png'),
    ]);
  });

  it('画像を押すと、拡大して表示する。閉じるボタン・背景・Escape で閉じる', () => {
    render(<Attachments attachments={[image('i1', 'pic.png')]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pic.png を拡大' }));
    const dialog = screen.getByRole('dialog', { name: 'pic.png の拡大' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/attachments/i1');
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'pic.png を拡大' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'pic.png を拡大' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
