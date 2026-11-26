import { describe, expect, it } from 'vitest';
import { hashSecret, verifySecret } from './password';

describe('hashSecret / verifySecret', () => {
  it('argon2id のハッシュを作り、元の文字列は含まれない', async () => {
    const hashed = await hashSecret('correct horse battery staple');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(hashed).not.toContain('correct horse');
  });

  it('同じ文字列でも、毎回、異なるハッシュになる(ソルト)', async () => {
    const [a, b] = await Promise.all([hashSecret('same-password'), hashSecret('same-password')]);
    expect(a).not.toBe(b);
  });

  it('正しい文字列だけが、一致する', async () => {
    const hashed = await hashSecret('password-1');
    expect(await verifySecret(hashed, 'password-1')).toBe(true);
    expect(await verifySecret(hashed, 'password-2')).toBe(false);
    expect(await verifySecret(hashed, '')).toBe(false);
  });

  it('日本語や絵文字も、扱える', async () => {
    const hashed = await hashSecret('パスワード😀😀😀');
    expect(await verifySecret(hashed, 'パスワード😀😀😀')).toBe(true);
    expect(await verifySecret(hashed, 'パスワード😀😀')).toBe(false);
  });

  it('壊れたハッシュは、例外にせず、不一致にする', async () => {
    expect(await verifySecret('not-a-hash', 'password-1')).toBe(false);
    expect(await verifySecret('', 'password-1')).toBe(false);
  });
});
