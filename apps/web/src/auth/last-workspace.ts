const KEY = 'raisechat:lastWorkspace';

/** 最後に開いたワークスペースの ID(ホームを開いたときに、そこへ戻るため)。使えない環境では、null */
export function getLastWorkspace(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastWorkspace(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // 保存できなくても、使い続けられる
  }
}

export function clearLastWorkspace(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 同上
  }
}
