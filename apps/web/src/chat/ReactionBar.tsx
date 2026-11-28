import type { ReactionSummary } from '@raisechat/shared';
import { useState } from 'react';
import { errorMessage } from '../api/client';

/** 選べる絵文字(よく使うもの) */
export const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '🚀', '😢'];

/** 付けた人の名前(title に出す)。名前が分からない人は、出さない */
export function reactorNames(userIds: string[], names: ReadonlyMap<string, string>): string {
  return userIds
    .map((id) => names.get(id))
    .filter((n): n is string => n !== undefined)
    .join('、');
}

/**
 * メッセージのリアクション(FR-108)。絵文字ごとの件数と、付けた人(title)を表示し、
 * 自分が付けたものは強調する(aria-pressed)。押すと、付与・解除を切り替える。
 * 「リアクションを追加」で、絵文字を選べる。
 */
export function ReactionBar({
  reactions,
  myId,
  names,
  onToggle,
}: {
  reactions: ReactionSummary[];
  myId: string | undefined;
  names: ReadonlyMap<string, string>;
  /** mine: いま自分が付けているか(付けていれば、解除する) */
  onToggle: (emoji: string, mine: boolean) => Promise<unknown>;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMine = (emoji: string) =>
    myId !== undefined &&
    (reactions.find((r) => r.emoji === emoji)?.userIds.includes(myId) ?? false);

  async function toggle(emoji: string) {
    setError(null);
    try {
      await onToggle(emoji, isMine(emoji));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="reactions">
      {reactions.map((r) => {
        const mine = isMine(r.emoji);
        return (
          <button
            key={r.emoji}
            type="button"
            className={mine ? 'reaction reaction-mine' : 'reaction'}
            aria-pressed={mine}
            title={reactorNames(r.userIds, names)}
            onClick={() => void toggle(r.emoji)}
          >
            {r.emoji} {r.count}
          </button>
        );
      })}
      <button
        type="button"
        aria-label="リアクションを追加"
        aria-expanded={picking}
        onClick={() => setPicking((v) => !v)}
      >
        ＋
      </button>
      {picking && (
        <div role="group" aria-label="絵文字を選ぶ" className="emoji-picker">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              onClick={() => {
                setPicking(false);
                void toggle(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
