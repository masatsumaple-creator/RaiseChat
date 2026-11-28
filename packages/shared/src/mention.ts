/**
 * メンションの解析(FR-109。設計書 §5.6)。
 * 本文から、アットマークとユーザー名の並びを取り出す。ユーザー名は、半角英数字とアンダースコア(3〜32 文字)で、
 * 大文字小文字を区別しない(取り出した名前は、小文字にそろえる)。
 * コードのブロック・インラインコードの中は、対象外。直前が、英数字・アンダースコアのとき(メールアドレスなど)も、対象外。
 */

const MENTION_PATTERN = /(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{3,32})(?![A-Za-z0-9_])/g;

/** フェンス付きコードブロックの中を、取り除く(閉じられていなければ、本文の最後まで) */
function stripFencedBlocks(body: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      // 開始。バッククォートのフェンスの情報文字列には、バッククォートを含められない
      if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
        fence = { char: m[1]![0]!, length: m[1]!.length };
        continue;
      }
      kept.push(line);
    } else if (
      m &&
      m[1]![0] === fence.char &&
      m[1]!.length >= fence.length &&
      m[2]!.trim() === ''
    ) {
      fence = null;
    }
  }
  return kept.join('\n');
}

/** インラインコード(同じ長さのバッククォートで囲んだ部分)を、取り除く */
function stripInlineCode(text: string): string {
  return text.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

/** 本文のメンションの名前(小文字。重複なし。出てきた順) */
export function extractMentionNames(body: string): string[] {
  const text = stripInlineCode(stripFencedBlocks(body));
  const names = new Set<string>();
  for (const m of text.matchAll(MENTION_PATTERN)) names.add(m[1]!.toLowerCase());
  return [...names];
}

/** メッセージの有効なメンション(応答に含める。FR-109) */
export interface MentionResponse {
  userId: string;
  username: string;
}

/** mention:created のペイロード(メンションされた人の user ルームへ) */
export interface MentionCreatedPayload {
  messageId: number;
  channelId: string;
  workspaceId: string;
}
