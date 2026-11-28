import type { MessageResponse } from '@raisechat/shared';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import { Attachments } from './Attachments';
import { Markdown } from './Markdown';
import { MessageEditor } from './MessageEditor';
import { ReactionBar } from './ReactionBar';

/** メンバーの ID から、表示名を引く表(リアクションの付与者の表示に使う) */
export type NameMap = ReadonlyMap<string, string>;

/**
 * メッセージ 1 件(トップレベルも、スレッドの返信も)。本文は、マークダウンで整形して表示する(FR-106)。
 * 自分のメッセージは、編集(FR-103)と削除(確認つき。FR-104)ができる。リアクション(FR-108)を付けられる。
 * onOpenThread があれば(トップレベルのとき)、返信の件数と、スレッドを開く操作を出す(FR-105)。
 */
export function MessageItem({
  message: m,
  myId,
  names,
  onEdit,
  onDelete,
  onToggleReaction,
  onOpenThread,
}: {
  message: MessageResponse;
  myId: string | undefined;
  names: NameMap;
  onEdit: (body: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onToggleReaction: (emoji: string, mine: boolean) => Promise<unknown>;
  onOpenThread?: () => void;
}) {
  const mine = myId !== undefined && m.author.id === myId;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  }

  return (
    <li>
      {m.author.avatarUrl && <img src={m.author.avatarUrl} alt="" width={24} height={24} />}
      <strong>{m.author.displayName}</strong>{' '}
      <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString('ja-JP')}</time>
      {m.editedAt && <span className="edited">(編集済み)</span>}
      {editing ? (
        <MessageEditor
          initialBody={m.body}
          onSave={async (body) => {
            await onEdit(body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown mentions={m.mentions.map((x) => x.username)}>{m.body}</Markdown>
      )}
      <Attachments attachments={m.attachments} />
      <ReactionBar reactions={m.reactions} myId={myId} names={names} onToggle={onToggleReaction} />
      {onOpenThread && (
        <button type="button" className="reply-count" onClick={onOpenThread}>
          {m.replyCount > 0 ? `返信 ${m.replyCount} 件` : '返信'}
        </button>
      )}
      {mine && !editing && (
        <div className="message-actions">
          {confirming ? (
            <>
              <span>このメッセージを削除しますか?</span>
              <button type="button" disabled={deleting} onClick={() => void remove()}>
                削除する
              </button>
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>
                キャンセル
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)}>
                編集
              </button>
              <button type="button" onClick={() => setConfirming(true)}>
                削除
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
