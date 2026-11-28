import { describe, expect, it } from 'vitest';
import { extractMentionNames } from './mention';

describe('extractMentionNames(FR-109)', () => {
  it('アットマークとユーザー名を取り出す。出てきた順', () => {
    expect(extractMentionNames('hi @alice and @bob_2!')).toEqual(['alice', 'bob_2']);
  });

  it('大文字小文字は区別しない(小文字にそろえる)。同じ人を複数回書いても 1 件', () => {
    expect(extractMentionNames('@Alice @ALICE @alice')).toEqual(['alice']);
  });

  it('行頭・句読点・日本語の直後でも取り出す', () => {
    expect(extractMentionNames('@alice\nよろしく、@bob。お願い@carol')).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
  });

  it('ユーザー名の長さの範囲外(3 文字未満・33 文字以上)は、対象外', () => {
    expect(extractMentionNames('@ab')).toEqual([]);
    expect(extractMentionNames(`@${'a'.repeat(32)}`)).toEqual(['a'.repeat(32)]);
    expect(extractMentionNames(`@${'a'.repeat(33)}`)).toEqual([]);
  });

  it('直前が英数字・アンダースコア(メールアドレスなど)なら、対象外', () => {
    expect(extractMentionNames('mail me: bob@example.com, a_@bob')).toEqual([]);
  });

  it('フェンス付きコードブロックの中は、対象外。前後は対象', () => {
    expect(extractMentionNames('@aaa\n```\n@bbb\n```\n@ccc')).toEqual(['aaa', 'ccc']);
    expect(extractMentionNames('~~~js\n@bbb\n~~~\n@ccc')).toEqual(['ccc']);
    // 長いフェンスの中の、短いフェンスでは、閉じない
    expect(extractMentionNames('````\n```\n@bbb\n````\n@ccc')).toEqual(['ccc']);
  });

  it('閉じられていないフェンスは、本文の最後まで、コードとして扱う', () => {
    expect(extractMentionNames('@aaa\n```\n@bbb\n@ccc')).toEqual(['aaa']);
  });

  it('インラインコードの中は、対象外。前後は対象', () => {
    expect(extractMentionNames('@aaa `@bbb` @ccc')).toEqual(['aaa', 'ccc']);
    expect(extractMentionNames('``a ` @bbb`` @ccc')).toEqual(['ccc']);
  });

  it('閉じられていないバッククォートは、コードではない', () => {
    expect(extractMentionNames('`@bbb')).toEqual(['bbb']);
  });
});
