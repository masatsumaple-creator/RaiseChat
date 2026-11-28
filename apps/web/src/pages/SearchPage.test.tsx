// @vitest-environment jsdom
import type { SearchResult, WorkspaceResponse } from '@raisechat/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, mockApi, type Handler } from '../test/mock-api';
import { SearchPage } from './SearchPage';
import { WorkspaceShell } from './WorkspaceShell';

const ME = { id: 'u1', username: 'taro', displayName: '太郎', statusText: '', avatarUrl: null };
const WS: WorkspaceResponse = { id: 'ws1', name: '部屋', role: 'member' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function result(id: number, body: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    channelId: 'c1',
    channelType: 'public',
    channelName: 'general',
    peerName: null,
    parentId: null,
    author: { id: 'u9', username: 'hanako', displayName: '花子', avatarUrl: null },
    body,
    createdAt: '2026-01-01T09:00:00.000Z',
    editedAt: null,
    ...extra,
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(path: string, routes: Record<string, Handler>) {
  const api = mockApi({
    'GET /api/me': () => json(200, ME),
    'GET /api/workspaces': () => json(200, [WS]),
    'GET /api/workspaces/ws1': () => json(200, WS),
    'GET /api/workspaces/ws1/channels': () => json(200, []),
    ...routes,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/w/:wsId" element={<WorkspaceShell />}>
            <Route index element={<p>先頭</p>} />
            <Route path="search" element={<SearchPage />} />
            <Route path="c/:chId" element={<p>チャンネルの画面</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return api;
}

const url = (q: string, cursor?: number) =>
  `GET /api/workspaces/ws1/search?q=${encodeURIComponent(q)}${cursor === undefined ? '' : `&cursor=${cursor}`}`;

describe('検索のボックス', () => {
  it('入力して送信すると、結果の画面へ移る(検索語は URL の q)。空は移らない', async () => {
    renderAt('/w/ws1', { [url('りんご')]: () => json(200, { results: [], nextCursor: null }) });
    const box = (await screen.findByLabelText('メッセージを検索')) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: '検索' }));
    expect(screen.getByTestId('where').textContent).toBe('/w/ws1');
    fireEvent.change(box, { target: { value: '  りんご ' } });
    fireEvent.click(screen.getByRole('button', { name: '検索' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(
        `/w/ws1/search?q=${encodeURIComponent('りんご')}`,
      ),
    );
    expect(
      await screen.findByText('「りんご」に一致するメッセージは、見つかりませんでした。'),
    ).toBeTruthy();
    // 結果の画面では、入力欄に、検索語が入っている
    expect(box.value).toBe('りんご');
  });
});

describe('SearchPage(FR-110)', () => {
  it('結果を新しい順に表示する: 投稿者・日時・チャンネル名・抜粋(一致した語を強調)', async () => {
    renderAt('/w/ws1/search?q=りんご', {
      [url('りんご')]: () =>
        json(200, {
          results: [
            result(3, '新しい りんご です'),
            result(2, '秘密の りんご', { channelType: 'private', channelName: 'ひみつ' }),
            result(1, 'DM の りんご', {
              channelType: 'dm',
              channelName: null,
              peerName: '次郎',
            }),
          ],
          nextCursor: null,
        }),
    });
    const list = await screen.findByRole('list', { name: '検索結果' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('花子');
    expect(items[0]!.textContent).toContain('# general');
    expect(items[1]!.textContent).toContain('🔒 ひみつ');
    expect(items[2]!.textContent).toContain('@ 次郎');
    const marks = [...list.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['りんご', 'りんご', 'りんご']);
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe('/w/ws1/c/c1');
  });

  it('返信の結果は、スレッドのパネルを開く URL(thread=親の ID)へのリンクで、「スレッドの返信」と示す', async () => {
    renderAt('/w/ws1/search?q=ねぎ', {
      [url('ねぎ')]: () =>
        json(200, { results: [result(5, '返信の ねぎ', { parentId: 4 })], nextCursor: null }),
    });
    const link = (await screen.findByRole('link', { name: /返信の/ })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/w/ws1/c/c1?thread=4');
    expect(link.textContent).toContain('(スレッドの返信)');
  });

  it('結果を押すと、そのチャンネルへ移る', async () => {
    renderAt('/w/ws1/search?q=りんご', {
      [url('りんご')]: () => json(200, { results: [result(1, '移る りんご')], nextCursor: null }),
    });
    fireEvent.click(await screen.findByRole('link', { name: /移る/ }));
    expect(await screen.findByText('チャンネルの画面')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/w/ws1/c/c1');
  });

  it('1 文字以下・空は、検索せず(API を呼ばず)、案内を表示する', async () => {
    const api = renderAt('/w/ws1/search?q=あ', {});
    expect(await screen.findByText('検索語は、2 文字以上で入力してください。')).toBeTruthy();
    expect(api.calls.some((c) => c.includes('/search'))).toBe(false);
  });

  it('結果が 0 件なら、その旨を表示する', async () => {
    renderAt('/w/ws1/search?q=なにもない', {
      [url('なにもない')]: () => json(200, { results: [], nextCursor: null }),
    });
    expect(
      await screen.findByText('「なにもない」に一致するメッセージは、見つかりませんでした。'),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: '検索結果' })).toBeNull();
  });

  it('次のページがあれば、「さらに読み込む」で cursor を渡して続きを取り、結果に足す。最後のページでは出ない', async () => {
    const api = renderAt('/w/ws1/search?q=ページ', {
      [url('ページ')]: () =>
        json(200, { results: [result(60, 'ページ 新'), result(59, 'ページ 中')], nextCursor: 59 }),
      [url('ページ', 59)]: () =>
        json(200, { results: [result(10, 'ページ 旧')], nextCursor: null }),
    });
    await screen.findByRole('link', { name: /中/ });
    fireEvent.click(screen.getByRole('button', { name: 'さらに読み込む' }));
    await screen.findByRole('link', { name: /旧/ });
    expect(
      within(screen.getByRole('list', { name: '検索結果' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('ページ 新'),
      expect.stringContaining('ページ 中'),
      expect.stringContaining('ページ 旧'),
    ]);
    expect(screen.queryByRole('button', { name: 'さらに読み込む' })).toBeNull();
    expect(api.calls.filter((c) => c.includes('/search'))).toHaveLength(2);
  });

  it('検索に失敗したら、エラーと再試行を表示する', async () => {
    let calls = 0;
    renderAt('/w/ws1/search?q=失敗', {
      [url('失敗')]: () => {
        calls += 1;
        return calls === 1
          ? apiError(500, 'internal_error', '検索に失敗しました。')
          : json(200, { results: [result(1, '成功 失敗')], nextCursor: null });
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('検索に失敗しました。');
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByText(/成功/);
  });
});
