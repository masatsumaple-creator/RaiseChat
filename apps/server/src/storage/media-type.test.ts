import { describe, expect, it } from 'vitest';
import { detectMediaType, detectVideoType } from './media-type';
import {
  GIF_HEADER,
  JPEG_HEADER,
  MP4_HEADER,
  PNG_HEADER,
  WEBM_HEADER,
  WEBP_HEADER,
} from '../test/files';

const pad = (header: Buffer, size = 64) => {
  const out = Buffer.alloc(size, 0);
  header.copy(out);
  return out;
};

describe('detectVideoType(内容による動画の判定。FR-107)', () => {
  it('MP4(ftyp と、許す major brand)・WebM(EBML と、DocType webm)を判定する', () => {
    expect(detectVideoType(pad(MP4_HEADER))).toEqual({ mime: 'video/mp4', ext: 'mp4' });
    expect(detectVideoType(pad(WEBM_HEADER))).toEqual({ mime: 'video/webm', ext: 'webm' });
  });

  it.each(['mp41', 'mp42', 'iso2', 'avc1', 'dash', 'M4V '])(
    'MP4 の major brand %s を許す',
    (brand) => {
      const header = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from(`ftyp${brand}`, 'ascii'),
      ]);
      expect(detectVideoType(pad(header))?.mime).toBe('video/mp4');
    },
  );

  it.each(['heic', 'avif', 'qt  ', '3gp4', 'M4A '])(
    'ftyp でも、動画として許さない形式(%s)は、拒否する',
    (brand) => {
      const header = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from(`ftyp${brand}`, 'ascii'),
      ]);
      expect(detectVideoType(pad(header))).toBeNull();
    },
  );

  it('同じ EBML のヘッダでも、DocType が webm でない(Matroska)なら、拒否する', () => {
    const mkv = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]),
      Buffer.from('matroska', 'ascii'),
    ]);
    expect(detectVideoType(pad(mkv))).toBeNull();
  });

  it('短すぎる・別の内容(HTML・実行ファイル・空)は、拒否する', () => {
    expect(detectVideoType(Buffer.alloc(0))).toBeNull();
    expect(detectVideoType(Buffer.from('ftyp'))).toBeNull();
    expect(detectVideoType(Buffer.from('<html><body>video</body></html>'))).toBeNull();
    expect(detectVideoType(Buffer.from('MZ\u0090\u0000'))).toBeNull();
  });
});

describe('detectMediaType(画像・動画)', () => {
  it('画像は image、動画は video として判定する', () => {
    expect(detectMediaType(PNG_HEADER)).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(detectMediaType(JPEG_HEADER)).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(detectMediaType(GIF_HEADER)).toMatchObject({ kind: 'image', mime: 'image/gif' });
    expect(detectMediaType(WEBP_HEADER)).toMatchObject({ kind: 'image', mime: 'image/webp' });
    expect(detectMediaType(pad(MP4_HEADER))).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(detectMediaType(pad(WEBM_HEADER))).toMatchObject({ kind: 'video', mime: 'video/webm' });
  });

  it('SVG・HTML・テキストは、拒否する', () => {
    expect(
      detectMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    ).toBeNull();
    expect(detectMediaType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(detectMediaType(Buffer.from('hello'))).toBeNull();
  });
});
