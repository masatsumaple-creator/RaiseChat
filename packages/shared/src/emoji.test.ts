import { describe, expect, it } from 'vitest';
import { EMOJI_MAX_CODE_POINTS, isSingleEmoji } from './emoji';

describe('isSingleEmoji: 許す(絵文字 1 つ)', () => {
  it.each([
    ['通常の絵文字', '😀'],
    ['手の絵文字', '👍'],
    ['ハート(異体字セレクタつき)', '❤️'],
    ['星', '⭐'],
    ['チェック', '✅'],
    ['肌の色つき', '👍🏽'],
    ['肌の色(単独)', '🏽'],
    ['ZWJ で組み合わせた家族', '👨‍👩‍👧‍👦'],
    ['ZWJ で組み合わせた職業', '👩‍💻'],
    ['ZWJ と異体字セレクタ', '🏳️‍🌈'],
    ['国旗(日本)', '🇯🇵'],
    ['国旗(米国)', '🇺🇸'],
    ['地域の旗(タグ文字。イングランド)', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
    ['キーキャップ(1)', '1️⃣'],
    ['キーキャップ(#)', '#️⃣'],
    ['キーキャップ(異体字セレクタなし)', '1⃣'],
    ['犬', '🐶'],
  ])('%s: %s', (_name, value) => {
    expect(isSingleEmoji(value), value).toBe(true);
  });
});

describe('isSingleEmoji: 許さない', () => {
  it('空文字', () => {
    expect(isSingleEmoji('')).toBe(false);
  });

  it.each([
    ['英字', 'a'],
    ['英単語', 'ok'],
    ['数字', '1'],
    ['記号', '#'],
    ['日本語', 'あ'],
    ['空白', ' '],
    ['改行', '\n'],
    ['制御文字', '\u0000'],
    ['ZWJ だけ', '‍'],
    ['異体字セレクタだけ', '️'],
    ['囲みだけ', '⃣'],
    ['文字の見た目の記号(©)', '©'],
    ['文字の見た目の記号(™)', '™'],
    ['文字の見た目の記号(®)', '®'],
    ['地域指示記号が 1 つだけ', '🇯'],
    ['地域指示記号が 3 つ', '🇯🇵🇺'],
  ])('%s: %s', (_name, value) => {
    expect(isSingleEmoji(value), JSON.stringify(value)).toBe(false);
  });

  it.each([
    ['絵文字が 2 つ', '😀😀'],
    ['別の絵文字が 2 つ', '👍❤️'],
    ['国旗が 2 つ', '🇯🇵🇺🇸'],
    ['絵文字と文字', '😀a'],
    ['文字と絵文字', 'a😀'],
    ['絵文字と空白', '😀 '],
    ['前後の空白', ' 😀'],
    ['絵文字と改行', '😀\n'],
    ['ZWJ が先頭', '‍😀'],
    ['ZWJ で文字をつなぐ', '😀‍a'],
    ['絵文字と、HTML', '😀<script>'],
    ['絵文字と、パス区切り', '😀/😀'],
  ])('%s', (_name, value) => {
    expect(isSingleEmoji(value), JSON.stringify(value)).toBe(false);
  });

  it(`長すぎるもの(${EMOJI_MAX_CODE_POINTS} コードポイントを超える)は許さない`, () => {
    // ZWJ でつないだ長い列は、1 つの書記素にまとまることがあるが、長さの上限で拒否する
    const tooLong = Array.from({ length: 20 }, () => '👩').join('‍');
    expect([...tooLong].length).toBeGreaterThan(EMOJI_MAX_CODE_POINTS);
    expect(isSingleEmoji(tooLong)).toBe(false);
  });

  it('上限以内なら、長い組み合わせも許す(家族の絵文字は、7 コードポイント)', () => {
    expect([...'👨‍👩‍👧‍👦'].length).toBeLessThanOrEqual(EMOJI_MAX_CODE_POINTS);
    expect(isSingleEmoji('👨‍👩‍👧‍👦')).toBe(true);
  });
});
