// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

function html(source: string): HTMLElement {
  const { container } = render(<Markdown>{source}</Markdown>);
  return container;
}

describe('Markdown の整形(FR-106)', () => {
  it('太字・斜体・取り消し線・インラインコード', () => {
    const c = html('**太** *斜* ~~消~~ `code`');
    expect(c.querySelector('strong')?.textContent).toBe('太');
    expect(c.querySelector('em')?.textContent).toBe('斜');
    expect(c.querySelector('del')?.textContent).toBe('消');
    expect(c.querySelector('p code')?.textContent).toBe('code');
  });

  it('コードブロック', () => {
    const c = html('```js\nconst a = 1;\n```');
    expect(c.querySelector('pre code')?.textContent).toBe('const a = 1;\n');
  });

  it('リスト(箇条書き・番号つき)と引用', () => {
    const c = html('- あ\n- い\n\n1. 一\n2. 二\n\n> 引用');
    expect([...c.querySelectorAll('ul > li')].map((e) => e.textContent)).toEqual(['あ', 'い']);
    expect([...c.querySelectorAll('ol > li')].map((e) => e.textContent)).toEqual(['一', '二']);
    expect(c.querySelector('blockquote')?.textContent?.trim()).toBe('引用');
  });

  it('リンクは、新しいタブで、noopener noreferrer つきで開く', () => {
    const a = html('[例](https://example.com/x)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('空行で、段落に分かれる', () => {
    expect(html('一\n\n二').querySelectorAll('p')).toHaveLength(2);
  });
});

describe('Markdown の無害化(XSS。設計書 §5.6)', () => {
  const dangerous = [
    '<script>window.__xss = 1</script>',
    '<img src=x onerror="window.__xss = 1">',
    '<a href="x" onclick="window.__xss = 1">c</a>',
    '<iframe src="https://example.com"></iframe>',
    '<div onmouseover="window.__xss = 1">d</div>',
    '<svg onload="window.__xss = 1"></svg>',
    '<style>body{display:none}</style>',
  ];

  it.each(dangerous)('生の HTML は描画しない: %s', (source) => {
    const c = html(source);
    expect(c.querySelector('script, iframe, style, svg, img')).toBeNull();
    for (const el of c.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) expect(attr).not.toMatch(/^on/i);
    }
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox(1))',
  ])('危険なスキームは、リンクにしない: %s', (source) => {
    const c = html(source);
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('x');
  });

  it('画像は読み込まない(代替テキストだけ)', () => {
    const c = html('![代替](https://example.com/a.png)');
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('代替');
  });

  it('安全なスキーム(http・mailto)もリンクになる', () => {
    expect(html('[a](http://example.com)').querySelector('a')).not.toBeNull();
    expect(html('[a](mailto:a@example.com)').querySelector('a')).not.toBeNull();
  });
});
