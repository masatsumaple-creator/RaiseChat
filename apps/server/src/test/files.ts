import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 各形式の、先頭のバイト列(マジックバイト)。判定は、先頭しか見ないので、中身はなくてもよい */
export const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
export const GIF_HEADER = Buffer.from('GIF89a', 'ascii');
export const WEBP_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
]);

/** MP4: サイズ(4 バイト)+ ftyp + major brand(isom)+ minor version */
export const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
]);
/** WebM: EBML のヘッダ(DocType = webm) */
export const WEBM_HEADER = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]),
  Buffer.from('webm', 'ascii'),
]);

/** 先頭に header を置き、ちょうど size バイトにしたファイルを作る */
export function fileOfSize(header: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size, 0x41);
  header.copy(out);
  return out;
}

export interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

/** multipart/form-data の本文を作る(app.inject に渡す) */
export function multipart(parts: MultipartPart[]) {
  const boundary = '----raisechat-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head), part.data ?? Buffer.from(part.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** テスト用の、一時ディレクトリを作る。close() で、中身ごと削除する */
export async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'raisechat-test-'));
  return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}
