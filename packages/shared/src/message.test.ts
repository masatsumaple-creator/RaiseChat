import { describe, expect, it } from 'vitest';
import {
  hasForbiddenControlChars,
  MESSAGE_BODY_MAX_LENGTH,
  messageListQuerySchema,
  postMessageSchema,
} from './message';

describe('hasForbiddenControlChars', () => {
  it('改行・復帰・タブは許し、NUL・ESC・BEL・DEL などは禁止する', () => {
    expect(hasForbiddenControlChars('a\nb\r\nc\td')).toBe(false);
    expect(hasForbiddenControlChars('日本語 😀 ✓')).toBe(false);
    for (const bad of ['\u0000', '\u0007', '\u001b', '\u007f', 'a\u0008b', '\u000b', '\u000c']) {
      expect(hasForbiddenControlChars(bad), JSON.stringify(bad)).toBe(true);
    }
  });
});

describe('postMessageSchema', () => {
  it('入力のまま(前後の空白も)通す', () => {
    expect(postMessageSchema.parse({ body: '  hi\n' })).toEqual({ body: '  hi\n' });
  });

  it('上限はコードポイント数', () => {
    expect(
      postMessageSchema.safeParse({ body: '😀'.repeat(MESSAGE_BODY_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      postMessageSchema.safeParse({ body: '😀'.repeat(MESSAGE_BODY_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('空白だけ・制御文字・余分な項目は拒否する', () => {
    for (const value of [{ body: '' }, { body: ' \n' }, { body: 'a\u0000' }, { body: 'x', y: 1 }]) {
      expect(postMessageSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('messageListQuerySchema', () => {
  it('cursor は正の整数(文字列でも受け付ける)。省略できる', () => {
    expect(messageListQuerySchema.parse({})).toEqual({});
    expect(messageListQuerySchema.parse({ cursor: '12' })).toEqual({ cursor: 12 });
    for (const cursor of ['0', '-3', '1.2', 'x']) {
      expect(messageListQuerySchema.safeParse({ cursor }).success, cursor).toBe(false);
    }
  });
});
