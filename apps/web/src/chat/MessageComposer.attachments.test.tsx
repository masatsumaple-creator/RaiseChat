// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MessageComposer } from './MessageComposer';

afterEach(cleanup);

const png = (name = 'a.png') => new File(['x'.repeat(100)], name, { type: 'image/png' });
const mp4 = (name = 'v.mp4') => new File(['x'.repeat(200)], name, { type: 'video/mp4' });

function setup(onSend = vi.fn().mockResolvedValue(undefined), allowAttachments = true) {
  render(<MessageComposer onSend={onSend} allowAttachments={allowAttachments} />);
  const textarea = screen.getByLabelText('メッセージ') as HTMLTextAreaElement;
  const input = () => screen.getByLabelText('ファイルを添付') as HTMLInputElement;
  const pick = (...files: File[]) => fireEvent.change(input(), { target: { files } });
  return { onSend, textarea, input, pick };
}

describe('MessageComposer: ファイルの添付(FR-107)', () => {
  it('allowAttachments がなければ、ファイルの選択を出さず、本文だけを送る(従来どおり)', async () => {
    const { onSend, textarea } = setup(undefined, false);
    expect(screen.queryByLabelText('ファイルを添付')).toBeNull();
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hi'));
  });

  it('許可形式を選ぶ(accept)。選んだファイルを、名前とサイズつきで一覧し、送信で、本文と一緒に渡す。送ったら、空になる', async () => {
    const { onSend, textarea, input, pick } = setup();
    expect(input().multiple).toBe(true);
    expect(input().accept).toContain('image/png');
    expect(input().accept).toContain('video/mp4');
    const a = png();
    const b = mp4();
    pick(a, b);
    const list = screen.getByRole('list', { name: '添付するファイル' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('a.png(100 B)'), expect.stringContaining('v.mp4(200 B)')]);
    fireEvent.change(textarea, { target: { value: '添付つき' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('添付つき', [a, b]));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: '添付するファイル' })).toBeNull(),
    );
    expect(textarea.value).toBe('');
  });

  it('選んだファイルを、取り消せる(送信にも、含まれない)', async () => {
    const { onSend, textarea, pick } = setup();
    const a = png('a.png');
    const b = png('b.png');
    pick(a, b);
    fireEvent.click(screen.getByRole('button', { name: 'a.png を取り消す' }));
    expect(screen.queryByText(/a\.png/)).toBeNull();
    fireEvent.change(textarea, { target: { value: 'x' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('x', [b]));
  });

  it('許可形式でない・上限を超えるファイルは、加えず、理由を示す。加えられるものは、加える', () => {
    const { pick } = setup();
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' });
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    pick(svg, big, png('ok.png'));
    const errors = screen.getByRole('alert', { name: '添付できなかったファイル' });
    expect(
      within(errors)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'a.svg: 画像(JPEG・PNG・GIF・WebP)か、動画(MP4・WebM)を選んでください。',
      'big.png: 画像は 10MB 以下にしてください。',
    ]);
    expect(
      within(screen.getByRole('list', { name: '添付するファイル' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('6 つ目からは、加えない(5 ファイルまで)', () => {
    const { pick } = setup();
    pick(...Array.from({ length: 6 }, (_, i) => png(`f${i}.png`)));
    expect(
      within(screen.getByRole('list', { name: '添付するファイル' })).getAllByRole('listitem'),
    ).toHaveLength(5);
    expect(screen.getByRole('alert').textContent).toContain('f5.png: 添付は、5 ファイルまでです。');
  });

  it('本文が空白だけなら、添付があっても、送信できない(本文は必須)', () => {
    const { onSend, textarea, pick } = setup();
    pick(png());
    fireEvent.change(textarea, { target: { value: '  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('送信に失敗したら、本文と、選んだファイルを残して、サーバーのエラーを示す', async () => {
    const { textarea, pick } = setup(
      vi.fn().mockRejectedValue(new ApiError(400, 'unsupported_file', 'サーバーが拒否しました')),
    );
    pick(png());
    fireEvent.change(textarea, { target: { value: '失敗' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect((await screen.findByText('サーバーが拒否しました')).tagName).toBe('P');
    expect(textarea.value).toBe('失敗');
    expect(screen.getByRole('list', { name: '添付するファイル' })).toBeTruthy();
  });
});
