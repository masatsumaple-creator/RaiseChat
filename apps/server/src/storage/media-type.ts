import { detectImageType, type ImageType } from './image-type';

export type VideoMime = 'video/mp4' | 'video/webm';

export interface VideoType {
  mime: VideoMime;
  ext: 'mp4' | 'webm';
}

/** 添付として許す、判定済みの形式(FR-107) */
export type MediaType =
  | { kind: 'image'; mime: ImageType['mime']; ext: ImageType['ext'] }
  | { kind: 'video'; mime: VideoMime; ext: VideoType['ext'] };

const ascii = (data: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...data.subarray(offset, offset + length));

/**
 * MP4 として許す、ftyp の major brand。HEIC・AVIF(画像)、QuickTime、3GP など、同じ ftyp を使う別の形式は、許さない。
 */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'MSNV',
  'M4V ',
]);

/** WebM: EBML のヘッダ(1A 45 DF A3)で始まり、先頭の部分に、DocType の webm がある(同じヘッダの Matroska は、許さない) */
function isWebm(data: Uint8Array): boolean {
  if (
    data.length < 4 ||
    data[0] !== 0x1a ||
    data[1] !== 0x45 ||
    data[2] !== 0xdf ||
    data[3] !== 0xa3
  ) {
    return false;
  }
  // EBML ヘッダの中の DocType(42 82 + 長さ + 文字列)を探す。ヘッダは、小さいので、先頭の 64 バイトだけを見る
  const head = data.subarray(0, 64);
  for (let i = 4; i + 6 < head.length; i += 1) {
    if (head[i] === 0x42 && head[i + 1] === 0x82) {
      const length = head[i + 2]! & 0x7f;
      return ascii(head, i + 3, length) === 'webm';
    }
  }
  return false;
}

/**
 * ファイルの内容から、動画の形式を判定する(FR-107)。ファイル名の拡張子や、申告された Content-Type は、見ない。
 * 対応: MP4(ftyp)、WebM(EBML)。
 */
export function detectVideoType(data: Uint8Array): VideoType | null {
  // MP4: 4 バイトのサイズ + "ftyp" + major brand
  if (data.length >= 12 && ascii(data, 4, 4) === 'ftyp' && MP4_BRANDS.has(ascii(data, 8, 4))) {
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (isWebm(data)) return { mime: 'video/webm', ext: 'webm' };
  return null;
}

/** 添付の形式を、内容で判定する(画像・動画)。許可形式でなければ null */
export function detectMediaType(data: Uint8Array): MediaType | null {
  const image = detectImageType(data);
  if (image) return { kind: 'image', ...image };
  const video = detectVideoType(data);
  if (video) return { kind: 'video', ...video };
  return null;
}
