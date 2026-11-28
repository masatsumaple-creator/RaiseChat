import type { ChannelMemberResponse } from '@raisechat/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { errorMessage } from '../api/client';
import { addFiles, ATTACHMENT_ACCEPT, formatSize } from './attachment-rules';
import { applyMention, findMentionQuery } from './mention-text';

/**
 * メッセージの入力欄(FR-101)。
 * - Enter で送信、Shift+Enter で改行
 * - 日本語入力の変換中の Enter(確定)では、送信しない
 * - 空白だけは、送らない。送信に成功したら、入力欄を空にする。失敗したら、入力を残して、エラーを示す
 * - allowAttachments なら、ファイル(画像・動画。5 つまで)を添付できる(FR-107)。選んだファイルは、一覧に出て、取り消せる。
 *   形式・サイズ・数は、選んだときに確認して、外れたものは加えず、理由を示す(サーバーの検証が正で、これは補助)
 * - fetchCandidates があれば、アットマークの後ろで、そのチャンネルの参加者を候補に出して、補完する(FR-109)。
 *   候補が開いている間は、↑↓ で選び、Enter か Tab で確定し、Escape で閉じる(Enter は、送信しない)。
 *   変換中は、候補の操作をしない
 */
export function MessageComposer({
  onSend,
  label = 'メッセージ',
  fetchCandidates,
  allowAttachments = false,
}: {
  onSend: (body: string, files?: File[]) => Promise<unknown>;
  /** 入力欄の名前(同じ画面に、複数あるときに、見分けるため) */
  label?: string;
  /** メンションの候補を取る(q は、アットマークの後ろの文字列。ユーザー名・表示名の前方一致) */
  fetchCandidates?: (q: string) => Promise<ChannelMemberResponse[]>;
  /** ファイルの添付を、できるようにする(トップレベルの投稿だけ) */
  allowAttachments?: boolean;
}) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ChannelMemberResponse[]>([]);
  const [active, setActive] = useState(0);
  /** Escape で閉じた、アットマークの位置(同じメンションの間は、開き直さない) */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const mention = fetchCandidates ? findMentionQuery(body, caret) : null;
  const open = mention !== null && mention.start !== dismissedAt && candidates.length > 0;
  const mentionStart = mention?.start;
  const mentionQuery = mention?.query;

  // 候補を取る(古い応答は、捨てる)
  useEffect(() => {
    if (!fetchCandidates || mentionStart === undefined || mentionQuery === undefined) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    fetchCandidates(mentionQuery).then(
      (list) => {
        if (cancelled) return;
        setCandidates(list.slice(0, 8));
        setActive(0);
      },
      () => {
        if (!cancelled) setCandidates([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchCandidates, mentionStart, mentionQuery]);

  // 候補を選んだあとの、カーソルの位置
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !textarea.current) return;
    textarea.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [body]);

  async function submit() {
    if (sending || body.trim().length === 0) return;
    setSending(true);
    setError(null);
    try {
      await (allowAttachments ? onSend(body, files) : onSend(body));
      setBody('');
      setFiles([]);
      setFileErrors([]);
      setCaret(0);
      setDismissedAt(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  function choose(member: ChannelMemberResponse) {
    if (!mention) return;
    const next = applyMention(body, mention, caret, member.username);
    pendingCaret.current = next.caret;
    setBody(next.text);
    setCaret(next.caret);
    setCandidates([]);
    textarea.current?.focus();
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // 同じファイルを、続けて選べるよう、選択を空にする
    event.target.value = '';
    const result = addFiles(files, picked);
    setFiles(result.files);
    setFileErrors(result.errors);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setBody(event.target.value);
    setCaret(event.target.selectionStart);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 変換中の Enter は、変換の確定。送信も、候補の確定も、しない
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : candidates.length - 1;
        setActive((i) => (i + step) % candidates.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        choose(candidates[active]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedAt(mention!.start);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  return (
    <form onSubmit={onSubmit} className="composer">
      <label>
        {label}
        <textarea
          ref={textarea}
          name="message"
          rows={2}
          value={body}
          onChange={onChange}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          placeholder="Enter で送信、Shift+Enter で改行"
          aria-autocomplete={fetchCandidates ? 'list' : undefined}
          aria-expanded={fetchCandidates ? open : undefined}
        />
      </label>
      {allowAttachments && (
        <div className="composer-files">
          <label>
            ファイルを添付
            <input type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={onPick} />
          </label>
          {files.length > 0 && (
            <ul aria-label="添付するファイル">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  {f.name}({formatSize(f.size)})
                  <button
                    type="button"
                    aria-label={`${f.name} を取り消す`}
                    onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}
                  >
                    取り消し
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fileErrors.length > 0 && (
            <ul role="alert" aria-label="添付できなかったファイル">
              {fileErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {open && (
        <ul role="listbox" aria-label="メンションの候補" className="mention-candidates">
          {candidates.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              // textarea の選択を外さないよう、mousedown で確定する
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m);
              }}
            >
              {m.displayName}(@{m.username})
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={sending || body.trim().length === 0}>
        送信
      </button>
    </form>
  );
}
