// @vitest-environment jsdom
import type { ChannelResponse, MessageResponse, WorkspaceResponse } from '@raisechat/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, mockApi } from '../test/mock-api';
import { ChannelNav } from './ChannelNav';
import { ChannelPage } from './ChannelPage';
import { WorkspaceShell } from './WorkspaceShell';

const ME = { id: 'u1', username: 'taro', displayName: '太郎', statusText: '', avatarUrl: null };
const WS: WorkspaceResponse = { id: 'ws1', name: '部屋', role: 'member' };
const OWNER_WS: WorkspaceResponse = { ...WS, role: 'owner' };

function channel(id: string, name: string, extra: Partial<ChannelResponse> = {}): ChannelResponse {
  return {
    id,
    workspaceId: 'ws1',
    type: 'public',
    name,
    isDefault: false,
    createdBy: 'u9',
    ...extra,
  };
}

function message(id: number, body: string, authorId = 'u9'): MessageResponse {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, username: authorId, displayName: `名前${authorId}`, avatarUrl: null },
    body,
    createdAt: '2026-01-01T09:00:00.000Z',
    parentId: null,
    editedAt: null,
    replyCount: 0,
    deleted: false,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChannelNav', () => {
  it('チャンネルを一覧し(プライベートは鍵つき)、いま開いているものに aria-current を付ける', () => {
    render(
      <MemoryRouter>
        <ChannelNav
          workspace={WS}
          channels={[
            channel('c1', 'general', { isDefault: true }),
            channel('c2', 'ひみつ', { type: 'private' }),
          ]}
          currentChannelId="c2"
        />
      </MemoryRouter>,
    );
    const links = within(screen.getByRole('navigation', { name: 'チャンネル' })).getAllByRole(
      'link',
    );
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['# general', '/w/ws1/c/c1'],
      ['🔒 ひみつ', '/w/ws1/c/c2'],
      ['チャンネルを作成', '/w/ws1/channels/new'],
      ['チャンネルを探す', '/w/ws1/channels/browse'],
      ['メンバー', '/w/ws1/members'],
    ]);
    expect(links[0]!.getAttribute('aria-current')).toBeNull();
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
  });

  it('招待リンクの管理は、オーナーにだけ出る', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ChannelNav workspace={OWNER_WS} channels={[]} currentChannelId={undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '招待リンクの管理' }).getAttribute('href')).toBe(
      '/w/ws1/invitations',
    );
    rerender(
      <MemoryRouter>
        <ChannelNav workspace={WS} channels={[]} currentChannelId={undefined} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: '招待リンクの管理' })).toBeNull();
  });
});

describe('ChannelPage(FR-101, 203, 204)', () => {
  function renderChannel(
    chId: string,
    routes: Record<string, () => Response | Promise<Response>>,
    workspace = WS,
  ) {
    const api = mockApi({
      'GET /api/me': () => json(200, ME),
      'GET /api/workspaces': () => json(200, [workspace]),
      'GET /api/workspaces/ws1': () => json(200, workspace),
      ...routes,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[`/w/ws1/c/${chId}`]}>
          <Routes>
            <Route path="/w/:wsId" element={<WorkspaceShell />}>
              <Route path="c/:chId" element={<ChannelPage />} />
              <Route index element={<p>ワークスペースの先頭</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return api;
  }

  const general = channel('c1', 'general', { isDefault: true });
  const base = {
    'GET /api/workspaces/ws1/channels': () => json(200, [general, channel('c2', '雑談')]),
    'GET /api/channels/c1/members': () => json(200, []),
    'GET /api/channels/c2/members': () => json(200, []),
  };

  it('メッセージを、古い順に表示する(API は新しい順)', async () => {
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () =>
        json(200, {
          messages: [message(3, '三'), message(2, '二'), message(1, '一')],
          nextCursor: null,
        }),
    });
    const list = await screen.findByRole('list', { name: 'メッセージ一覧' });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        expect.stringContaining('一'),
        expect.stringContaining('二'),
        expect.stringContaining('三'),
      ]),
    );
    expect(within(list).getAllByText(/名前u9/)).toHaveLength(3);
  });

  it('編集されたメッセージには「編集済み」、返信があれば返信数を表示する', async () => {
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () =>
        json(200, {
          messages: [
            { ...message(2, '直した'), editedAt: '2026-01-02T00:00:00.000Z', replyCount: 3 },
            message(1, 'そのまま'),
          ],
          nextCursor: null,
        }),
    });
    const list = await screen.findByRole('list', { name: 'メッセージ一覧' });
    const items = await within(list).findAllByRole('listitem');
    expect(items[0]!.textContent).toContain('そのまま');
    expect(items[0]!.textContent).not.toContain('編集済み');
    expect(items[1]!.textContent).toContain('直した');
    expect(items[1]!.textContent).toContain('(編集済み)');
    expect(items[1]!.textContent).toContain('返信 3 件');
  });

  it('削除済みの親は、本文・投稿者を出さず、「削除されました」と返信数だけを表示する', async () => {
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () =>
        json(200, {
          messages: [
            {
              id: 7,
              channelId: 'c1',
              createdAt: '2026-01-01T09:00:00.000Z',
              replyCount: 2,
              deleted: true,
            },
            message(6, '普通'),
          ],
          nextCursor: null,
        }),
    });
    const list = await screen.findByRole('list', { name: 'メッセージ一覧' });
    const items = await within(list).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[1]!.textContent).toContain('このメッセージは、削除されました');
    expect(items[1]!.textContent).toContain('返信 2 件');
    expect(items[1]!.textContent).not.toContain('名前');
  });

  it('メッセージがなければ、案内を出す', async () => {
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () => json(200, { messages: [], nextCursor: null }),
    });
    expect(await screen.findByText('まだ、メッセージはありません。')).toBeTruthy();
  });

  it('「さらに古いメッセージ」で、cursor を付けて、次のページを取る', async () => {
    const api = renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () =>
        json(200, { messages: [message(52, '新しい')], nextCursor: 52 }),
      'GET /api/channels/c1/messages?cursor=52': () =>
        json(200, { messages: [message(51, '古い')], nextCursor: null }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'さらに古いメッセージを読み込む' }));
    await waitFor(() => expect(screen.getByText('古い')).toBeTruthy());
    expect(api.calls).toContain('GET /api/channels/c1/messages?cursor=52');
    // 全部読み込んだら、ボタンは消える
    expect(screen.queryByRole('button', { name: 'さらに古いメッセージを読み込む' })).toBeNull();
  });

  it('投稿すると、本文のまま送り、自分のメッセージが一覧に加わる(イベントが届かなくても)', async () => {
    let sent: unknown;
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () => json(200, { messages: [], nextCursor: null }),
      'POST /api/channels/c1/messages': (() => {
        return ({ body }: { body: unknown }) => {
          sent = body;
          return json(201, message(1, '  こんにちは  ', 'u1'));
        };
      })() as unknown as () => Response,
    });
    const box = await screen.findByRole('textbox', { name: 'メッセージ' });
    fireEvent.change(box, { target: { value: '  こんにちは  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('名前u1')).toBeTruthy());
    expect(sent).toEqual({ body: '  こんにちは  ' });
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('既定のチャンネル(general)には、退出のボタンがない。それ以外にはある', async () => {
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () => json(200, { messages: [], nextCursor: null }),
    });
    await screen.findByRole('heading', { name: '# general' });
    expect(screen.queryByRole('button', { name: '退出' })).toBeNull();
    cleanup();

    renderChannel('c2', {
      ...base,
      'GET /api/channels/c2/messages': () => json(200, { messages: [], nextCursor: null }),
    });
    expect(await screen.findByRole('button', { name: '退出' })).toBeTruthy();
  });

  it('退出すると、API を呼び、ワークスペースの先頭へ移る', async () => {
    const api = renderChannel('c2', {
      ...base,
      'GET /api/channels/c2/messages': () => json(200, { messages: [], nextCursor: null }),
      'POST /api/channels/c2/leave': () => new Response(null, { status: 204 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '退出' }));
    expect(await screen.findByText('ワークスペースの先頭')).toBeTruthy();
    expect(api.calls).toContain('POST /api/channels/c2/leave');
  });

  it('参加していない・存在しないチャンネルは、区別せず、見つからない案内を出す(メッセージは取りにいかない)', async () => {
    const api = renderChannel('c-unknown', base);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('このチャンネルは、見つかりません');
    expect(api.calls.some((c) => c.includes('/messages'))).toBe(false);
  });

  it('プライベートチャンネルの招待は、作成者かオーナーにだけ出る', async () => {
    const secret = channel('c3', 'ひみつ', { type: 'private', createdBy: 'u9' });
    const routes = {
      'GET /api/workspaces/ws1/channels': () => json(200, [general, secret]),
      'GET /api/channels/c3/members': () =>
        json(200, [
          { id: 'u9', username: 'u9', displayName: '九', statusText: '', avatarUrl: null },
        ]),
      'GET /api/channels/c3/messages': () => json(200, { messages: [], nextCursor: null }),
      'GET /api/workspaces/ws1/members': () => json(200, []),
    };
    // 作成者でも、オーナーでもない参加者
    renderChannel('c3', routes);
    await screen.findByRole('heading', { name: '🔒 ひみつ' });
    expect(screen.queryByLabelText('招待する人')).toBeNull();
    cleanup();

    // オーナー
    renderChannel('c3', routes, OWNER_WS);
    await screen.findByRole('heading', { name: '🔒 ひみつ' });
    expect(await screen.findByLabelText('招待する人')).toBeTruthy();
  });

  it('サーバーのエラー(メッセージの取得の失敗)は、示して、再試行できる', async () => {
    renderChannel('c1', {
      ...base,
      'GET /api/channels/c1/messages': () => apiError(500, 'internal_error', '失敗しました'),
    });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('失敗しました'))).toBe(true);
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
  });
});
