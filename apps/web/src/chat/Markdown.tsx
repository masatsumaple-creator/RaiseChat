import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

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

/**
 * メッセージ本文の整形表示(FR-106。設計書 §5.6)。
 * サーバーは入力されたままの文字列を保存するので、ここで変換と無害化を行う。
 * 生の HTML は描画せず(react-markdown の既定)、rehype-sanitize で、さらに無害化する。
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{ a: Link, img: Image }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
