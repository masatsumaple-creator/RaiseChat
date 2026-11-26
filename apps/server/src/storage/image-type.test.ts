import { describe, expect, it } from 'vitest';
import { GIF_HEADER, JPEG_HEADER, PNG_HEADER, WEBP_HEADER } from '../test/files';
import { detectImageType, mimeFromExt } from './image-type';

describe('detectImageType(内容で判定する)', () => {
  it.each([
    ['JPEG', JPEG_HEADER, 'image/jpeg', 'jpg'],
    ['PNG', PNG_HEADER, 'image/png', 'png'],
    ['GIF89a', GIF_HEADER, 'image/gif', 'gif'],
    ['GIF87a', Buffer.from('GIF87a', 'ascii'), 'image/gif', 'gif'],
    ['WebP', WEBP_HEADER, 'image/webp', 'webp'],
  ])('%s を判定する', (_name, header, mime, ext) => {
    expect(detectImageType(header)).toEqual({ mime, ext });
  });

  it.each([
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['XML つきの SVG', Buffer.from('<?xml version="1.0"?><svg></svg>')],
    ['HTML', Buffer.from('<!DOCTYPE html><script>alert(1)</script>')],
    ['テキスト', Buffer.from('hello world, this is not an image')],
    ['PDF', Buffer.from('%PDF-1.7\n')],
    ['BMP', Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00])],
    ['空', Buffer.alloc(0)],
    ['1 バイト', Buffer.from([0xff])],
    ['JPEG の途中まで(FF D8 だけ)', Buffer.from([0xff, 0xd8])],
    ['PNG の途中まで', PNG_HEADER.subarray(0, 7)],
    ['GIF の版が違う(GIF90a)', Buffer.from('GIF90a', 'ascii')],
    [
      'RIFF だが WebP ではない(WAVE)',
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]),
    ],
    ['RIFF だけ', Buffer.from('RIFF')],
  ])('画像として認めない: %s', (_name, data) => {
    expect(detectImageType(data)).toBeNull();
  });

  it('先頭がずれている(前に空白がある)ものは、認めない', () => {
    expect(detectImageType(Buffer.concat([Buffer.from(' '), PNG_HEADER]))).toBeNull();
  });
});

describe('mimeFromExt', () => {
  it('保存する拡張子から、Content-Type を決める', () => {
    expect(mimeFromExt('jpg')).toBe('image/jpeg');
    expect(mimeFromExt('png')).toBe('image/png');
    expect(mimeFromExt('gif')).toBe('image/gif');
    expect(mimeFromExt('webp')).toBe('image/webp');
  });

  it('知らない拡張子は null(svg・html を返さない)', () => {
    for (const ext of ['svg', 'html', 'js', '', 'PNG']) expect(mimeFromExt(ext)).toBeNull();
  });
});
