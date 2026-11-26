import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * ファイルの保存先のインターフェース(設計書 §1)。開発はローカルディスク、本番は S3 互換に、差し替える。
 * キーは、`/` 区切りの相対パス(例: avatars/<ユーザー ID>/<uuid>.png)。
 */
export interface Storage {
  put(key: string, data: Uint8Array): Promise<void>;
  /** 内容を返す。存在しなければ null */
  get(key: string): Promise<Buffer | null>;
  /** 削除する。存在しなくても、成功とみなす(再試行しても安全なように) */
  delete(key: string): Promise<void>;
}

/** 安全なキーだけを許す: 英数字・`_`・`-`・`.`・`/`。先頭の `/`、`..`、空の要素、`\` は不可 */
const KEY_PATTERN =
  /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/;

export function isValidStorageKey(key: string): boolean {
  return key.length > 0 && key.length <= 512 && KEY_PATTERN.test(key) && !key.includes('..');
}

export class LocalDiskStorage implements Storage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  /** キーを、保存先の中のパスにする。外に出るキー(パストラバーサル)は、エラー */
  private resolve(key: string): string {
    if (!isValidStorageKey(key)) throw new Error('不正なストレージキーです');
    const full = path.resolve(this.root, ...key.split('/'));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('不正なストレージキーです');
    }
    return full;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
