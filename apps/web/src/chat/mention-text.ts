/** 入力中の、アットマークの後ろの文字列(メンションの補完の対象) */
export interface MentionQuery {
  /** アットマークの位置 */
  start: number;
  /** アットマークの後ろから、カーソルまでの文字列(空のこともある) */
  query: string;
}

const WORD = /[A-Za-z0-9_]/;

/**
 * カーソルの直前が「@名前」なら、その位置と名前(補完の対象)を返す。
 * アットマークの直前が、英数字・アンダースコア・アットマークのとき(メールアドレスなど)は、対象外。
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const m = /(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{0,32})$/.exec(before);
  if (!m) return null;
  return { start: m.index, query: m[1]! };
}

/**
 * 候補を選んだときの本文とカーソル位置。「@途中まで」(と、カーソルの後ろに続く名前の残り)を、
 * 「@ユーザー名」に置き換え、後ろに空白を 1 つ置く(すでに後ろが空白なら、それを使う)。カーソルは、その空白の後ろ。
 */
export function applyMention(
  text: string,
  mention: MentionQuery,
  caret: number,
  username: string,
): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && WORD.test(text[end]!)) end += 1;
  const rest = text.slice(end);
  const head = `${text.slice(0, mention.start)}@${username}`;
  const followedBySpace = rest.startsWith(' ');
  const next = followedBySpace ? head + rest : `${head} ${rest}`;
  return { text: next, caret: head.length + 1 };
}

/** 表示の部品: 通常の文字列、または、強調するメンション */
export type MentionPart = string | { mention: string };

/**
 * 文字列を、有効なメンション(@ユーザー名。大文字小文字を区別しない)と、それ以外に分ける。
 * サーバーの解析と同じく、直前が英数字・アンダースコア・アットマークのもの、後ろに名前の文字が続くものは、対象外。
 * usernames は、その本文の有効なメンション(応答の mentions)のユーザー名。
 */
export function splitMentions(text: string, usernames: string[]): MentionPart[] {
  if (usernames.length === 0 || !text.includes('@')) return [text];
  const wanted = new Set(usernames.map((u) => u.toLowerCase()));
  const parts: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(/(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{3,32})(?![A-Za-z0-9_])/g)) {
    if (!wanted.has(m[1]!.toLowerCase())) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ mention: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? [text] : parts;
}
