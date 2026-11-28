// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MessageEditor } from './MessageEditor';

afterEach(cleanup);

function setup(onSave = vi.fn().mockResolvedValue(undefined)) {
  const onCancel = vi.fn();
  render(<MessageEditor initialBody="元の本文" onSave={onSave} onCancel={onCancel} />);
  const textarea = screen.getByLabelText('メッセージを編集') as HTMLTextAreaElement;
  return { onSave, onCancel, textarea };
}

describe('MessageEditor(FR-103)', () => {
  it('いまの本文を、入力欄に戻して出す', () => {
    expect(setup().textarea.value).toBe('元の本文');
  });

  it('Enter か保存ボタンで、保存する', async () => {
    const { onSave, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '直した' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('直した'));
  });

  it('保存ボタンでも保存できる', async () => {
    const { onSave, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '直した' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('直した'));
  });

  it('Shift+Enter は改行、変換中の Enter は保存しない', () => {
    const { onSave, textarea } = setup();
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Escape とキャンセルボタンで、キャンセルする(保存しない)', () => {
    const { onSave, onCancel, textarea } = setup();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('空白だけは保存できない', () => {
    const { onSave, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '  \n ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('失敗したら、入力を残して、エラーを示す', async () => {
    const { textarea } = setup(
      vi.fn().mockRejectedValue(new ApiError(403, 'forbidden', '権限なし')),
    );
    fireEvent.change(textarea, { target: { value: '直した' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toBe('権限なし');
    expect(textarea.value).toBe('直した');
  });
});
