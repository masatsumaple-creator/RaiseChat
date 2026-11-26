import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCode,
  generateSessionToken,
  hashToken,
  normalizeRecoveryCode,
} from './tokens';

describe('generateSessionToken', () => {
  it('256 ビット(32 バイト)のランダム値を、URL に安全な文字列にする', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 バイトの base64url は 43 文字
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('毎回、異なる値になる', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateSessionToken));
    expect(tokens.size).toBe(1000);
  });
});

describe('hashToken', () => {
  it('SHA-256 の 16 進数で、同じ入力は同じ、違う入力は違う値になる', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('元のトークンは、ハッシュに含まれない', () => {
    const token = generateSessionToken();
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('generateRecoveryCode', () => {
  it('28 文字を、4 文字ずつ、ハイフンで区切る(140 ビット。基準は 128 ビット以上)', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(code.replace(/-/g, '')).toHaveLength(28);
  });

  it('読み間違えやすい文字(I, L, O, U)を含まない', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateRecoveryCode()).not.toMatch(/[ILOU]/);
    }
  });

  it('毎回、異なる値になる', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateRecoveryCode));
    expect(codes.size).toBe(1000);
  });

  it('32 種類の文字が、ほぼ均等に出る(偏りがない)', () => {
    const counts = new Map<string, number>();
    const rounds = 3000;
    for (let i = 0; i < rounds; i++) {
      for (const ch of generateRecoveryCode().replace(/-/g, '')) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(32);
    const expected = (rounds * 28) / 32; // 2625
    for (const count of counts.values()) {
      // 標準偏差は約 50。±10% 以内なら、偏りなしとみなす
      expect(Math.abs(count - expected)).toBeLessThan(expected * 0.1);
    }
  });
});

describe('normalizeRecoveryCode', () => {
  it('ハイフン・空白を除き、大文字にする', () => {
    expect(normalizeRecoveryCode('abcd-efgh 1234')).toBe('ABCDEFGH1234');
    expect(normalizeRecoveryCode(' abcd\tefgh\n')).toBe('ABCDEFGH');
  });

  it('読み間違えやすい文字を、読み替える(O は 0、I と L は 1)', () => {
    expect(normalizeRecoveryCode('OIL0')).toBe('0110');
  });

  it('生成したコードを正規化しても、文字は変わらない(ハイフンだけが除かれる)', () => {
    const code = generateRecoveryCode();
    expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ''));
  });
});
