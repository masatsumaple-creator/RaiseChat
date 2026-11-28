// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MessageComposer } from './MessageComposer';

afterEach(cleanup);

function setup(onSend = vi.fn().mockResolvedValue(undefined)) {
  render(<MessageComposer onSend={onSend} />);
  const textarea = screen.getByLabelText('メッセージ') as HTMLTextAreaElement;
  return { onSend, textarea };
}

describe('MessageComposer(FR-101)', () => {
  it('Enter で送信し、成功したら入力欄を空にする', async () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'こんにちは' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('こんにちは'));
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('送信ボタンでも送信できる', async () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hi'));
  });

  it('Shift+Enter は改行で、送信しない', () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'a' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('日本語入力の変換中の Enter(確定)では、送信しない', () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'にほんご' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('空・空白だけは送信しない(ボタンも押せない)', () => {
    const { onSend, textarea } = setup();
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: ' \n ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('本文は、入力されたまま(前後の空白・改行も)送る', async () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '  一行目\n二行目  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('  一行目\n二行目  '));
  });

  it('失敗したら、入力を残して、サーバーのメッセージを示す', async () => {
    const onSend = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'validation_error', '本文が長すぎます'));
    const { textarea } = setup(onSend);
    fireEvent.change(textarea, { target: { value: 'x' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toBe('本文が長すぎます');
    expect(textarea.value).toBe('x');
  });

  it('送信中は、続けて Enter を押しても、二重に送らない', async () => {
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { textarea } = setup(onSend);
    fireEvent.change(textarea, { target: { value: 'once' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(textarea.value).toBe(''));
  });
});
