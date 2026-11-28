/**
 * ログイン・登録のあとに戻る場所(?next=)を、安全に取り出す。
 * 同じオリジンの、パス(/ で始まり、// や /\ で始まらないもの)だけを許す。
 * それ以外(外部の URL など)は、無視する(オープンリダイレクトを防ぐ)。
 */
export function safeNext(search: string): string | null {
  const value = new URLSearchParams(search).get('next');
  if (!value) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  // 制御文字(改行など)を含むものは、使わない
  for (const ch of value) {
    if (ch.codePointAt(0)! < 0x20) return null;
  }
  return value;
}

/** next つきのパス(ログイン・登録の画面へ、戻り先を引き継ぐ) */
export function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}
