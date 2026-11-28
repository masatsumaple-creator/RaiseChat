import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { errorMessage } from '../api/client';

/**
 * メッセージの入力欄(FR-101)。
 * - Enter で送信、Shift+Enter で改行
 * - 日本語入力の変換中の Enter(確定)では、送信しない
 * - 空白だけは、送らない。送信に成功したら、入力欄を空にする。失敗したら、入力を残して、エラーを示す
 */
export function MessageComposer({ onSend }: { onSend: (body: string) => Promise<unknown> }) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (sending || body.trim().length === 0) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setBody('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 変換中の Enter は、変換の確定。送信しない
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  }

  return (
    <form onSubmit={onSubmit} className="composer">
      <label>
        メッセージ
        <textarea
          name="message"
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Enter で送信、Shift+Enter で改行"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={sending || body.trim().length === 0}>
        送信
      </button>
    </form>
  );
}
