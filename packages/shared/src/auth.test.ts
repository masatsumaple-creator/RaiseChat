import { describe, expect, it } from 'vitest';
import { passwordSchema, profileUpdateSchema, registerRequestSchema, usernameSchema } from './auth';

describe('usernameSchema', () => {
  it.each(['abc', 'Alice', 'a_1', 'A'.repeat(32), '___'])('%s は有効', (name) => {
    expect(usernameSchema.safeParse(name).success).toBe(true);
  });

  it.each(['ab', 'a'.repeat(33), 'with space', 'ひらがな', 'a-b', 'a.b', '', 'abc\n'])(
    '%j は無効',
    (name) => {
      expect(usernameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe('passwordSchema(コードポイント数で数える)', () => {
  it('8 文字ちょうどは有効、7 文字は無効', () => {
    expect(passwordSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(7)).success).toBe(false);
  });

  it('絵文字 8 個は有効(UTF-16 では 16 だが、コードポイントでは 8)', () => {
    expect(passwordSchema.safeParse('😀'.repeat(8)).success).toBe(true);
    expect(passwordSchema.safeParse('😀'.repeat(7)).success).toBe(false);
  });

  it('128 文字ちょうどは有効、129 文字は無効', () => {
    expect(passwordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse('😀'.repeat(128)).success).toBe(true);
  });

  it('空白だけでも、長さを満たせば有効(内容は制限しない)', () => {
    expect(passwordSchema.safeParse(' '.repeat(8)).success).toBe(true);
  });
});

describe('registerRequestSchema', () => {
  it('ユーザー名とパスワードの両方を検証する', () => {
    expect(
      registerRequestSchema.safeParse({ username: 'alice', password: 'password1' }).success,
    ).toBe(true);
    expect(registerRequestSchema.safeParse({ username: 'a', password: 'password1' }).success).toBe(
      false,
    );
    expect(registerRequestSchema.safeParse({ username: 'alice', password: 'short' }).success).toBe(
      false,
    );
    expect(registerRequestSchema.safeParse({ username: 'alice' }).success).toBe(false);
  });
});

describe('profileUpdateSchema(FR-004)', () => {
  const ok = (v: unknown) => profileUpdateSchema.safeParse(v).success;

  it('表示名とステータスの、どちらか一方でも更新できる', () => {
    expect(ok({ displayName: 'Taro' })).toBe(true);
    expect(ok({ statusText: '会議中' })).toBe(true);
    expect(ok({ displayName: 'Taro', statusText: '会議中' })).toBe(true);
  });

  it('何も指定しない・余分な項目がある場合は無効', () => {
    expect(ok({})).toBe(false);
    expect(ok({ username: 'x' })).toBe(false);
    expect(ok({ displayName: 'Taro', avatarKey: 'x' })).toBe(false);
  });

  it('前後の空白は取り除く。空白だけの表示名は無効、空白だけのステータスは空になる', () => {
    expect(profileUpdateSchema.parse({ displayName: '  Taro  ' }).displayName).toBe('Taro');
    expect(ok({ displayName: '   ' })).toBe(false);
    expect(profileUpdateSchema.parse({ statusText: '   ' }).statusText).toBe('');
  });

  it('文字数は、コードポイント数で数える(境界)', () => {
    expect(ok({ displayName: '😀'.repeat(50) })).toBe(true);
    expect(ok({ displayName: '😀'.repeat(51) })).toBe(false);
    expect(ok({ statusText: '😀'.repeat(100) })).toBe(true);
    expect(ok({ statusText: '😀'.repeat(101) })).toBe(false);
  });

  it('制御文字は無効', () => {
    expect(ok({ displayName: 'a\nb' })).toBe(false);
    expect(ok({ statusText: 'a\tb' })).toBe(false);
  });
});
