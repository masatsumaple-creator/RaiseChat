import { ATTACHMENT_MAX_FILES, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES } from '@raisechat/shared';

/** 選べるファイルの MIME と拡張子(file の accept に使う。クライアントの確認は補助で、サーバーの検証が正。FR-107) */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXTS = ['mp4', 'webm'];

export const ATTACHMENT_ACCEPT = [
  ...IMAGE_TYPES,
  ...VIDEO_TYPES,
  ...[...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`),
].join(',');

export type FileKind = 'image' | 'video';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** ファイルの種類の目安(MIME か拡張子から)。許可形式でなければ null。実際の判定は、サーバーが内容で行う */
export function kindOf(file: Pick<File, 'name' | 'type'>): FileKind | null {
  const type = file.type.toLowerCase();
  if (IMAGE_TYPES.includes(type)) return 'image';
  if (VIDEO_TYPES.includes(type)) return 'video';
  if (type === '' || type === 'application/octet-stream') {
    const ext = extensionOf(file.name);
    if (IMAGE_EXTS.includes(ext)) return 'image';
    if (VIDEO_EXTS.includes(ext)) return 'video';
  }
  return null;
}

/** サイズを、読みやすい文字にする(例: 1.5 MB) */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AddResult {
  /** 追加したあとの、選択中のファイル */
  files: File[];
  /** 受け付けなかった理由(なければ空) */
  errors: string[];
}

/**
 * 選んだファイルを、選択中のファイルに加える。形式・サイズ・数(合計 5 つまで)を確認し、外れたものは加えない。
 * これは、事前の確認で、サーバーも、必ず、内容で検証する。
 */
export function addFiles(current: File[], picked: File[]): AddResult {
  const files = [...current];
  const errors: string[] = [];
  for (const file of picked) {
    const kind = kindOf(file);
    if (!kind) {
      errors.push(`${file.name}: 画像(JPEG・PNG・GIF・WebP)か、動画(MP4・WebM)を選んでください。`);
      continue;
    }
    const max = kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (file.size > max) {
      errors.push(
        `${file.name}: ${kind === 'image' ? '画像は 10MB' : '動画は 50MB'} 以下にしてください。`,
      );
      continue;
    }
    if (file.size === 0) {
      errors.push(`${file.name}: 空のファイルは、添付できません。`);
      continue;
    }
    if (files.length >= ATTACHMENT_MAX_FILES) {
      errors.push(`${file.name}: 添付は、${ATTACHMENT_MAX_FILES} ファイルまでです。`);
      continue;
    }
    files.push(file);
  }
  return { files, errors };
}
