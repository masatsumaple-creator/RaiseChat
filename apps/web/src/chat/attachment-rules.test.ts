import { describe, expect, it } from 'vitest';
import { addFiles, formatSize, kindOf } from './attachment-rules';

const MB = 1024 * 1024;

/** 指定のサイズの、File(中身は作らず、size だけを上書きする。大きなバッファを避けるため) */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('kindOf(種類の目安)', () => {
  it('MIME で判定する', () => {
    expect(kindOf({ name: 'a', type: 'image/png' })).toBe('image');
    expect(kindOf({ name: 'a', type: 'image/webp' })).toBe('image');
    expect(kindOf({ name: 'a', type: 'video/mp4' })).toBe('video');
    expect(kindOf({ name: 'a', type: 'video/webm' })).toBe('video');
  });

  it('MIME が空・汎用なら、拡張子で判定する(大文字小文字を区別しない)', () => {
    expect(kindOf({ name: 'A.JPG', type: '' })).toBe('image');
    expect(kindOf({ name: 'a.jpeg', type: 'application/octet-stream' })).toBe('image');
    expect(kindOf({ name: 'clip.MP4', type: '' })).toBe('video');
  });

  it('許可形式でなければ null(SVG・PDF・HTML・拡張子なし・MIME と拡張子の食い違い)', () => {
    expect(kindOf({ name: 'a.svg', type: 'image/svg+xml' })).toBeNull();
    expect(kindOf({ name: 'a.pdf', type: 'application/pdf' })).toBeNull();
    expect(kindOf({ name: 'a.html', type: 'text/html' })).toBeNull();
    expect(kindOf({ name: 'noext', type: '' })).toBeNull();
    expect(kindOf({ name: 'a.png', type: 'text/plain' })).toBeNull();
    expect(kindOf({ name: 'a.mov', type: 'video/quicktime' })).toBeNull();
  });
});

describe('addFiles(事前の確認)', () => {
  it('許可形式で、上限以内なら、加える。順序は、選んだ順', () => {
    const a = fakeFile('a.png', 'image/png', 100);
    const b = fakeFile('b.mp4', 'video/mp4', 100);
    const result = addFiles([a], [b]);
    expect(result.files).toEqual([a, b]);
    expect(result.errors).toEqual([]);
  });

  it('サイズの上限: 画像は 10MB まで、動画は 50MB まで(ちょうどは通り、+1 は、加えない)', () => {
    const okImage = fakeFile('ok.png', 'image/png', 10 * MB);
    const okVideo = fakeFile('ok.mp4', 'video/mp4', 50 * MB);
    expect(addFiles([], [okImage, okVideo]).errors).toEqual([]);

    const bigImage = fakeFile('big.png', 'image/png', 10 * MB + 1);
    const bigVideo = fakeFile('big.mp4', 'video/mp4', 50 * MB + 1);
    const result = addFiles([], [bigImage, bigVideo]);
    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([
      'big.png: 画像は 10MB 以下にしてください。',
      'big.mp4: 動画は 50MB 以下にしてください。',
    ]);
  });

  it('数の上限: 合計 5 つまで。超えた分は加えず、理由を示す', () => {
    const files = Array.from({ length: 4 }, (_, i) => fakeFile(`f${i}.png`, 'image/png', 10));
    const extra = [fakeFile('x.png', 'image/png', 10), fakeFile('y.png', 'image/png', 10)];
    const result = addFiles(files, extra);
    expect(result.files).toHaveLength(5);
    expect(result.files[4]).toBe(extra[0]);
    expect(result.errors).toEqual(['y.png: 添付は、5 ファイルまでです。']);
  });

  it('許可形式でない・空のファイルは、加えない。良いファイルは加える', () => {
    const good = fakeFile('g.png', 'image/png', 10);
    const svg = fakeFile('a.svg', 'image/svg+xml', 10);
    const empty = fakeFile('e.png', 'image/png', 0);
    const result = addFiles([], [svg, good, empty]);
    expect(result.files).toEqual([good]);
    expect(result.errors).toEqual([
      'a.svg: 画像(JPEG・PNG・GIF・WebP)か、動画(MP4・WebM)を選んでください。',
      'e.png: 空のファイルは、添付できません。',
    ]);
  });

  it('元の配列は、変えない', () => {
    const current: File[] = [];
    addFiles(current, [fakeFile('a.png', 'image/png', 1)]);
    expect(current).toEqual([]);
  });
});

describe('formatSize', () => {
  it('単位を付けて、読みやすくする', () => {
    expect(formatSize(500)).toBe('500 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(5 * MB)).toBe('5.0 MB');
  });
});
