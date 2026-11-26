import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir } from '../test/files';
import { isValidStorageKey, LocalDiskStorage } from './storage';

let temp: Awaited<ReturnType<typeof makeTempDir>>;
let root: string;
let storage: LocalDiskStorage;

beforeAll(async () => {
  temp = await makeTempDir();
  root = path.join(temp.dir, 'root');
  await mkdir(root);
  storage = new LocalDiskStorage(root);
});

afterAll(async () => {
  await temp.close();
});

describe('LocalDiskStorage', () => {
  it('保存して、同じ内容を取得できる(途中のディレクトリも作る)', async () => {
    await storage.put('avatars/u1/a.png', Buffer.from([1, 2, 3]));
    expect(await storage.get('avatars/u1/a.png')).toEqual(Buffer.from([1, 2, 3]));
    expect((await stat(path.join(root, 'avatars', 'u1', 'a.png'))).isFile()).toBe(true);
  });

  it('存在しないキーの取得は null', async () => {
    expect(await storage.get('avatars/none/x.png')).toBeNull();
  });

  it('削除できる。存在しないキーの削除も、成功する(再試行しても安全)', async () => {
    await storage.put('avatars/u2/b.png', Buffer.from('x'));
    await storage.delete('avatars/u2/b.png');
    expect(await storage.get('avatars/u2/b.png')).toBeNull();
    await expect(storage.delete('avatars/u2/b.png')).resolves.toBeUndefined();
    await expect(storage.delete('avatars/never/existed.png')).resolves.toBeUndefined();
  });

  it('同じキーに保存すると、上書きされる', async () => {
    await storage.put('avatars/u3/c.png', Buffer.from('old'));
    await storage.put('avatars/u3/c.png', Buffer.from('new'));
    expect((await storage.get('avatars/u3/c.png'))?.toString()).toBe('new');
  });

  it.each([
    '../outside.txt',
    'avatars/../../outside.txt',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'avatars\\..\\..\\outside.txt',
    'avatars/./a.png',
    'avatars//a.png',
    'avatars/a.png/',
    '.hidden',
    'a\u0000b.png',
    '',
  ])('パストラバーサルなどの不正なキー(%j)は、保存・取得・削除のすべてで拒否する', async (key) => {
    expect(isValidStorageKey(key)).toBe(false);
    await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow('不正なストレージキー');
    await expect(storage.get(key)).rejects.toThrow('不正なストレージキー');
    await expect(storage.delete(key)).rejects.toThrow('不正なストレージキー');
  });

  it('保存先の外のファイルは、読み書き・削除できない', async () => {
    const outside = path.join(temp.dir, 'outside.txt');
    await writeFile(outside, 'secret');
    await expect(storage.get('../outside.txt')).rejects.toThrow();
    await expect(storage.delete('../outside.txt')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('secret');
  });
});

describe('isValidStorageKey', () => {
  it('アバターのキーの形式を、許可する', () => {
    expect(isValidStorageKey('avatars/3f2b8c1e-0a5d-4c7e-9b1a-2d3e4f5a6b7c/9e8d7c6b.png')).toBe(
      true,
    );
    expect(isValidStorageKey('a.b.c')).toBe(true);
  });

  it('長すぎるキーは拒否する', () => {
    expect(isValidStorageKey('a'.repeat(513))).toBe(false);
    expect(isValidStorageKey('a'.repeat(512))).toBe(true);
  });
});
