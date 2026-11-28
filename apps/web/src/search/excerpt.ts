import { SEARCH_MIN_LENGTH, codePointLength } from '@raisechat/shared';

/** 表示の部品: 通常の文字列、または、強調する、一致した部分 */
export type ExcerptPart = string | { match: string };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** 検索語として使う文字列(前後の空白を除く。サーバーと同じ) */
export const normalizeTerm = (raw: string) => raw.trim();

/** 検索できる長さか(コードポイント数で 2 文字以上。FR-110) */
export const isSearchable = (raw: string) =>
  codePointLength(normalizeTerm(raw)) >= SEARCH_MIN_LENGTH;

/**
 * 本文から、一致した部分の周りを、抜粋する(最初の一致の前後。長い本文は、省略記号をつける)。
 * 一致は、大文字小文字を区別しない(サーバーの ILIKE と同じ)。一致した部分は、強調の部品にする。
 */
export function excerptParts(body: string, rawTerm: string, radius = 40): ExcerptPart[] {
  const term = normalizeTerm(rawTerm);
  if (term === '') return [body];
  const lowerBody = body.toLowerCase();
  const lowerTerm = term.toLowerCase();
  // toLowerCase で長さが変わる文字(İ など)があると、位置がずれるので、その場合は、強調しない
  if (lowerBody.length !== body.length || lowerTerm.length !== term.length) return [body];

  const first = lowerBody.indexOf(lowerTerm);
  if (first < 0) return [body];

  let start = Math.max(0, first - radius);
  let end = Math.min(body.length, first + term.length + radius);
  // 絵文字(サロゲートペア)を、途中で切らない
  if (start > 0 && isLowSurrogate(body.charCodeAt(start))) start -= 1;
  if (end < body.length && isHighSurrogate(body.charCodeAt(end - 1))) end += 1;
  const parts: ExcerptPart[] = [];
  if (start > 0) parts.push('…');
  let cursor = start;
  let at = first;
  while (at >= 0 && at < end) {
    if (at > cursor) parts.push(body.slice(cursor, at));
    parts.push({ match: body.slice(at, at + term.length) });
    cursor = at + term.length;
    at = lowerBody.indexOf(lowerTerm, cursor);
  }
  if (cursor < end) parts.push(body.slice(cursor, end));
  if (end < body.length) parts.push('…');
  return parts;
}
