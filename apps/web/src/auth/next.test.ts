import { describe, expect, it } from 'vitest';
import { safeNext, withNext } from './next';

describe('safeNext', () => {
  it('同じオリジンのパスだけを返す', () => {
    expect(safeNext('?next=%2Finvite%2Fabc')).toBe('/invite/abc');
    expect(safeNext('?next=/w/123?x=1')).toBe('/w/123?x=1');
  });

  it('なければ null', () => {
    expect(safeNext('')).toBeNull();
    expect(safeNext('?other=1')).toBeNull();
    expect(safeNext('?next=')).toBeNull();
  });

  it('外部の URL・スキーム相対・バックスラッシュ・スキームつきは、使わない(オープンリダイレクトの防止)', () => {
    for (const bad of [
      'https://evil.example/',
      'http://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'evil.example/path',
      'invite/abc',
    ]) {
      expect(safeNext(`?next=${encodeURIComponent(bad)}`), bad).toBeNull();
    }
  });

  it('制御文字を含むものは、使わない', () => {
    expect(safeNext(`?next=${encodeURIComponent('/a\nb')}`)).toBeNull();
    expect(safeNext(`?next=${encodeURIComponent('/a\u0000b')}`)).toBeNull();
  });
});

describe('withNext', () => {
  it('next があれば、エンコードして付ける', () => {
    expect(withNext('/login', '/invite/a b')).toBe('/login?next=%2Finvite%2Fa%20b');
    expect(withNext('/login', null)).toBe('/login');
  });
});
