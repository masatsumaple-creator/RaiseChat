import { describe, expect, it } from 'vitest';
import { excerptParts, isSearchable, normalizeTerm } from './excerpt';

describe('isSearchable / normalizeTerm(FR-110)', () => {
  it('前後の空白を除いて、2 文字以上(コードポイント数)なら、検索できる', () => {
    expect(normalizeTerm('  あい  ')).toBe('あい');
    expect(isSearchable('あい')).toBe(true);
    expect(isSearchable('  ab ')).toBe(true);
    expect(isSearchable('あ')).toBe(false);
    expect(isSearchable('  あ  ')).toBe(false);
    expect(isSearchable('')).toBe(false);
    expect(isSearchable('   ')).toBe(false);
    // 絵文字は、1 文字
    expect(isSearchable('😀')).toBe(false);
    expect(isSearchable('😀😀')).toBe(true);
  });
});

describe('excerptParts(抜粋と、一致した部分の強調)', () => {
  it('一致した部分を、強調の部品にする。大文字小文字を区別しない(本文の表記のまま)', () => {
    expect(excerptParts('Hello World', 'world')).toEqual(['Hello ', { match: 'World' }]);
    expect(excerptParts('東京タワーに行った', '東京')).toEqual([
      { match: '東京' },
      'タワーに行った',
    ]);
  });

  it('同じ語が複数あれば、すべて強調する(抜粋の範囲の中)', () => {
    expect(excerptParts('りんごとりんご', 'りんご')).toEqual([
      { match: 'りんご' },
      'と',
      { match: 'りんご' },
    ]);
  });

  it('検索語の前後の空白は無視する。一致がなければ、本文のまま', () => {
    expect(excerptParts('abc def', '  def ')).toEqual(['abc ', { match: 'def' }]);
    expect(excerptParts('abc', 'zzz')).toEqual(['abc']);
    expect(excerptParts('abc', '   ')).toEqual(['abc']);
  });

  it('長い本文は、最初の一致の前後だけを抜粋して、省略記号をつける', () => {
    const body = `${'あ'.repeat(100)}キーワード${'い'.repeat(100)}`;
    const parts = excerptParts(body, 'キーワード', 10);
    expect(parts).toEqual(['…', 'あ'.repeat(10), { match: 'キーワード' }, 'い'.repeat(10), '…']);
  });

  it('先頭・末尾に近いときは、その側の省略記号をつけない', () => {
    expect(excerptParts(`キー${'い'.repeat(100)}`, 'キー', 5)).toEqual([
      { match: 'キー' },
      'い'.repeat(5),
      '…',
    ]);
    expect(excerptParts(`${'あ'.repeat(100)}キー`, 'キー', 5)).toEqual([
      '…',
      'あ'.repeat(5),
      { match: 'キー' },
    ]);
  });

  it('特殊文字(% _ \\ 正規表現の記号)も、文字どおりに強調する', () => {
    expect(excerptParts('50% off', '50%')).toEqual([{ match: '50%' }, ' off']);
    expect(excerptParts('a_b と a.b', 'a.b')).toEqual(['a_b と ', { match: 'a.b' }]);
    expect(excerptParts('C:\\temp', 'C:\\t')).toEqual([{ match: 'C:\\t' }, 'emp']);
  });

  it('絵文字(サロゲートペア)を、抜粋の端で、途中で切らない', () => {
    const body = `${'😀'.repeat(30)}キー${'😀'.repeat(30)}`;
    const parts = excerptParts(body, 'キー', 5);
    const text = parts.map((p) => (typeof p === 'string' ? p : p.match)).join('');
    // 孤立したサロゲートが、ない(エンコードして戻すと、同じ)
    expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
    expect(parts).toContainEqual({ match: 'キー' });
  });
});
