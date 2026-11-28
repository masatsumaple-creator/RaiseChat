/** 絵文字(1 つ)の長さの上限: コードポイント数。DB の CHECK(1〜32)と同じ(設計書 §2 の reactions) */
export const EMOJI_MAX_CODE_POINTS = 32;

/** 1 つのメッセージに付けられる、絵文字の種類の上限(設計書 §10 の T19) */
export const MAX_REACTION_KINDS_PER_MESSAGE = 20;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** キーキャップ(1️⃣ # など): 数字・# ・* と、任意の異体字セレクタと、囲み(U+20E3) */
const KEYCAP = /^[0-9#*]\u{FE0F}?\u{20E3}$/u;

/** 国旗: 地域指示記号の、ちょうど 2 つ */
const FLAG = /^\p{Regional_Indicator}{2}$/u;

/** 絵文字の先頭: 絵文字として表示される文字、または、異体字セレクタ(U+FE0F)つきの絵文字 */
const START = /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F})/u;

/** 絵文字の続き: 絵文字・ZWJ・異体字セレクタ・囲み・肌の色・タグ文字(地域の旗)だけ */
const TAIL =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u{200D}|\u{FE0F}|\u{20E3}|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])+$/u;

/**
 * Unicode 絵文字 1 つか(FR-108。設計書 §10 の T19)。
 * 肌の色・ZWJ で組み合わせた絵文字・国旗・キーキャップも、1 つとして許す。
 * 文字・数字・記号だけの文字列、複数の絵文字、空、長すぎるものは、許さない。
 * 絵文字として表示される形(または、異体字セレクタつき)だけを許す(© や ™ などの、文字の見た目のものは、許さない)。
 */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0) return false;
  if ([...value].length > EMOJI_MAX_CODE_POINTS) return false;
  // 見た目の上で、1 つ(書記素 1 つ)であること
  const segments = [...segmenter.segment(value)];
  if (segments.length !== 1) return false;
  if (KEYCAP.test(value)) return true;
  if (/\p{Regional_Indicator}/u.test(value)) return FLAG.test(value);
  return START.test(value) && TAIL.test(value);
}

/** メッセージの絵文字ごとのリアクション(FR-108): 付けた人(古い順)と、その件数 */
export interface ReactionSummary {
  emoji: string;
  count: number;
  /** 付けた人のユーザー ID(付けた順)。表示名は、ワークスペースのメンバー一覧から引く */
  userIds: string[];
}
