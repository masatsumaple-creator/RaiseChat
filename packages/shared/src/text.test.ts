import { describe, expect, it } from 'vitest';
import { codePointLength } from './text';

describe('codePointLength', () => {
  it('ASCII は、文字数のとおり', () => {
    expect(codePointLength('abc')).toBe(3);
  });

  it('日本語は、1 文字を 1 と数える', () => {
    expect(codePointLength('こんにちは')).toBe(5);
  });

  it('サロゲートペアの絵文字は、1 と数える(string.length は 2)', () => {
    expect('😀'.length).toBe(2);
    expect(codePointLength('😀')).toBe(1);
  });

  it('空文字は 0', () => {
    expect(codePointLength('')).toBe(0);
  });
});
