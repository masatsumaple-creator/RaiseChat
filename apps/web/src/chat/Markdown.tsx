import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { splitMentions } from './mention-text';

/** リンクにしてよいスキーム(それ以外の javascript: data: などは、リンクにしない) */
const SAFE_LINK = /^(https?:|mailto:)/i;

function Link({ href, children }: ComponentProps<'a'>) {
  if (!href || !SAFE_LINK.test(href)) return <span>{children}</span>;
  // 新しいタブで開く。開いた先から、元のページを操作されないようにする
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** 画像は読み込まない(外部へ通信させない)。代わりに、代替テキストを出す */
function Image({ alt }: ComponentProps<'img'>) {
  return <span>{alt ?? ''}</span>;
}

/** 変換後の木(hast)の、必要な部分だけの型(型の定義パッケージを、直接の依存にしないため) */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** コードの中は、強調しない(サーバーも、コードの中は、メンションにしない) */
const SKIP = new Set(['code', 'pre']);

function highlight(node: HastNode, usernames: string[]): void {
  const children: HastNode[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'element') {
      if (!SKIP.has(child.tagName ?? '')) highlight(child, usernames);
      children.push(child);
    } else if (child.type === 'text') {
      for (const part of splitMentions(child.value ?? '', usernames)) {
        children.push(
          typeof part === 'string'
            ? { type: 'text', value: part }
            : {
                type: 'element',
                tagName: 'span',
                properties: { className: ['mention'] },
                children: [{ type: 'text', value: part.mention }],
              },
        );
      }
    } else {
      children.push(child);
    }
  }
  node.children = children;
}

/**
 * 有効なメンション(@ユーザー名)を、強調する(FR-109)。無害化(rehype-sanitize)の後に実行する。
 * ここで加えるのは、自分で作る span(class は mention だけ)だけで、本文由来の属性は、増えない。
 */
function rehypeMentions(usernames: string[]) {
  return () => (tree: HastNode) => {
    if (usernames.length > 0) highlight(tree, usernames);
  };
}

/**
 * メッセージ本文の整形表示(FR-106)。サーバーは入力されたままの文字列を保存するので、ここで変換と無害化を行う。
 * 生の HTML は描画せず(react-markdown の既定)、rehype-sanitize で、さらに無害化する。
 * mentions は、その本文の有効なメンション(応答の mentions)のユーザー名。これだけを強調する。
 */
export function Markdown({ children, mentions = [] }: { children: string; mentions?: string[] }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize, rehypeMentions(mentions)]}
        components={{ a: Link, img: Image }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
