import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { errorMessage } from '../api/client';

/**
 * メッセージの編集欄(FR-103)。入力欄に、いまの本文を戻して、保存する。
 * - Enter で保存、Shift+Enter で改行、Escape でキャンセル。変換中の Enter は、保存しない
 * - 本文が空白だけなら、保存しない。失敗したら、入力を残して、エラーを示す
 */
export function MessageEditor({
  initialBody,
  onSave,
  onCancel,
}: {
  initialBody: string;
  onSave: (body: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (saving || body.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(body);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  return (
    <form onSubmit={onSubmit} className="message-editor">
      <label>
        メッセージを編集
        <textarea
          rows={3}
          value={body}
          autoFocus
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={saving || body.trim().length === 0}>
        保存
      </button>
      <button type="button" disabled={saving} onClick={onCancel}>
        キャンセル
      </button>
    </form>
  );
}
