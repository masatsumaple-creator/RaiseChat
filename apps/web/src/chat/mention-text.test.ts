import { describe, expect, it } from 'vitest';
import { applyMention, findMentionQuery, splitMentions } from './mention-text';

describe('findMentionQuery(補完の対象の検出)', () => {
  it('カーソルの直前の「@名前」を返す。アットマークだけなら、空の名前', () => {
    expect(findMentionQuery('@al', 3)).toEqual({ start: 0, query: 'al' });
    expect(findMentionQuery('こんにちは @', 7)).toEqual({ start: 6, query: '' });
    expect(findMentionQuery('a @bob_1', 8)).toEqual({ start: 2, query: 'bob_1' });
  });

  it('カーソルが名前の途中なら、カーソルまでを名前とする', () => {
    expect(findMentionQuery('@alice', 3)).toEqual({ start: 0, query: 'al' });
  });

  it('空白・改行の後ろは、新しい名前の開始', () => {
    expect(findMentionQuery('@alice @bo', 10)).toEqual({ start: 7, query: 'bo' });
    expect(findMentionQuery('@alice\n@b', 9)).toEqual({ start: 7, query: 'b' });
  });

  it('対象外: アットマークがない・名前の後ろに空白がある・直前が英数字(メールアドレス)・名前以外の文字', () => {
    expect(findMentionQuery('abc', 3)).toBeNull();
    expect(findMentionQuery('@alice ', 7)).toBeNull();
    expect(findMentionQuery('bob@example', 11)).toBeNull();
    expect(findMentionQuery('@@a', 3)).toBeNull();
    expect(findMentionQuery('@あ', 2)).toBeNull();
  });
});

describe('applyMention(候補の選択)', () => {
  it('「@途中まで」を「@ユーザー名」に置き換え、空白を 1 つ置く。カーソルは、その後ろ', () => {
    const q = findMentionQuery('hi @al', 6)!;
    expect(applyMention('hi @al', q, 6, 'alice')).toEqual({ text: 'hi @alice ', caret: 10 });
  });

  it('途中を選ぶと、後ろに続く名前の残りも置き換える。後ろに文字が続くなら、空白で区切る', () => {
    const q = findMentionQuery('@alxx です', 3)!;
    expect(applyMention('@alxx です', q, 3, 'alice')).toEqual({ text: '@alice です', caret: 7 });
    const q2 = findMentionQuery('@al日本', 3)!;
    expect(applyMention('@al日本', q2, 3, 'alice')).toEqual({ text: '@alice 日本', caret: 7 });
  });

  it('後ろがすでに空白なら、その空白を使い、空白を重ねない', () => {
    const q = findMentionQuery('@al です', 3)!;
    expect(applyMention('@al です', q, 3, 'alice')).toEqual({ text: '@alice です', caret: 7 });
  });

  it('改行の前でも、空白は 1 つ置く(改行は残る)', () => {
    const q = findMentionQuery('@al\n次', 3)!;
    expect(applyMention('@al\n次', q, 3, 'alice')).toEqual({ text: '@alice \n次', caret: 7 });
  });
});

describe('splitMentions(有効なメンションの強調)', () => {
  it('有効なメンションだけを、強調の部品に分ける(大文字小文字を区別しない)', () => {
    expect(splitMentions('やあ @Alice と @nobody', ['alice'])).toEqual([
      'やあ ',
      { mention: '@Alice' },
      ' と @nobody',
    ]);
  });

  it('複数・同じ人の複数回・先頭・末尾', () => {
    expect(splitMentions('@alice @bob_1 @alice', ['alice', 'bob_1'])).toEqual([
      { mention: '@alice' },
      ' ',
      { mention: '@bob_1' },
      ' ',
      { mention: '@alice' },
    ]);
  });

  it('対象外: 有効なメンションがない・直前が英数字・後ろに名前の文字が続く', () => {
    expect(splitMentions('@alice', [])).toEqual(['@alice']);
    expect(splitMentions('x@alice @alicex', ['alice'])).toEqual(['x@alice @alicex']);
  });

  it('アットマークがなければ、そのまま', () => {
    expect(splitMentions('こんにちは', ['alice'])).toEqual(['こんにちは']);
  });
});
