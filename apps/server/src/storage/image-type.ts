export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageType {
  mime: ImageMime;
  /** 保存するときの拡張子(ドットなし) */
  ext: 'jpg' | 'png' | 'gif' | 'webp';
}

const startsWith = (data: Uint8Array, bytes: number[], offset = 0) =>
  data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);

/**
 * ファイルの内容(マジックバイト)から、画像の形式を判定する(FR-004、FR-107)。
 * ファイル名の拡張子や、申告された Content-Type は、見ない(偽装できるため)。
 * 対応: JPEG、PNG、GIF、WebP。それ以外(SVG・HTML など)は null。
 */
export function detectImageType(data: Uint8Array): ImageType | null {
  // JPEG: FF D8 FF
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', ext: 'png' };
  }

  // GIF: "GIF87a" または "GIF89a"
  if (
    startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { mime: 'image/gif', ext: 'gif' };
  }

  // WebP: "RIFF" + 4 バイトのサイズ + "WEBP"
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', ext: 'webp' };
  }

  return null;
}

/** 保存したキーの拡張子から、配信する Content-Type を決める(判定済みの形式だけが保存されている) */
export function mimeFromExt(ext: string): ImageMime | null {
  switch (ext) {
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}
