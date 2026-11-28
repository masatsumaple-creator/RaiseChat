// @vitest-environment jsdom
import type { ChannelResponse, MessageResponse, WorkspaceResponse } from '@raisechat/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, mockApi, type Handler } from '../test/mock-api';
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
    peer: null,
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
    reactions: [],
    mentions: [],
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
  function renderChannel(chId: string, routes: Record<string, Handler>, workspace = WS) {
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

  describe('編集・削除・整形(FR-103, 104, 106)', () => {
    const own = (id: number, body: string, extra: Partial<MessageResponse> = {}) => ({
      ...message(id, body, 'u1'),
      ...extra,
    });
    const page =
      (...messages: unknown[]) =>
      () =>
        json(200, { messages, nextCursor: null });
    const done = () => new Response(null, { status: 204 });

    it('本文を、マークダウンで整形して表示する。生の HTML は描画せず、「編集済み」を出す', async () => {
      renderChannel('c1', {
        ...base,
        'GET /api/channels/c1/messages': page(message(2, '**太字** と <script>x</script>', 'u9'), {
          ...message(1, '古い', 'u9'),
          editedAt: '2026-01-01T10:00:00.000Z',
        }),
      });
      const list = await screen.findByRole('list', { name: 'メッセージ一覧' });
      await waitFor(() => expect(within(list).getByText('太字').tagName).toBe('STRONG'));
      expect(list.querySelector('script')).toBeNull();
      expect(within(list).getAllByText('(編集済み)')).toHaveLength(1);
    });

    it('編集と削除は、自分のメッセージにだけ出る', async () => {
      renderChannel('c1', {
        ...base,
        'GET /api/channels/c1/messages': page(message(2, '他人', 'u9'), own(1, '自分')),
      });
      await screen.findByText('自分');
      expect(screen.getAllByRole('button', { name: '編集' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: '削除' })).toHaveLength(1);
    });

    it('編集: 入力欄に本文を戻して保存すると、表示が置き換わり、「編集済み」が付く', async () => {
      const api = renderChannel('c1', {
        ...base,
        'GET /api/channels/c1/messages': page(own(1, '元')),
        'PATCH /api/messages/1': ({ body }) => {
          expect(body).toEqual({ body: '直した' });
          return json(200, own(1, '直した', { editedAt: '2026-01-01T10:00:00.000Z' }));
        },
      });
      await screen.findByText('元');
      fireEvent.click(screen.getByRole('button', { name: '編集' }));
      const box = screen.getByLabelText('メッセージを編集') as HTMLTextAreaElement;
      expect(box.value).toBe('元');
      fireEvent.change(box, { target: { value: '直した' } });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await waitFor(() => expect(screen.queryByLabelText('メッセージを編集')).toBeNull());
      expect(screen.getByText('直した')).toBeTruthy();
      expect(screen.getByText('(編集済み)')).toBeTruthy();
      expect(api.calls).toContain('PATCH /api/messages/1');
    });

    it('編集の失敗は、エラーを示し、編集欄を残す', async () => {
      renderChannel('c1', {
        ...base,
        'GET /api/channels/c1/messages': page(own(1, '元')),
        'PATCH /api/messages/1': () => apiError(404, 'not_found', '見つかりません。'),
      });
      await screen.findByText('元');
      fireEvent.click(screen.getByRole('button', { name: '編集' }));
      fireEvent.change(screen.getByLabelText('メッセージを編集'), { target: { value: '直した' } });
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      expect((await screen.findByRole('alert')).textContent).toBe('見つかりません。');
      expect(screen.getByLabelText('メッセージを編集')).toBeTruthy();
    });

    it('削除は、確認してから行う。キャンセルなら、何も起きない', async () => {
      const api = renderChannel('c1', {
        ...base,
        'GET /api/channels/c1/messages': page(own(1, '消すもの')),
        'DELETE /api/messages/1': done,
      });
      await screen.findByText('消すもの');
      fireEvent.click(screen.getByRole('button', { name: '削除' }));
      fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
      expect(api.calls).not.toContain('DELETE /api/messages/1');
      fireEvent.click(screen.getByRole('button', { name: '削除' }));
      expect(screen.getByText('このメッセージを削除しますか?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '削除する' }));
      await waitFor(() => expect(screen.queryByText('消すもの')).toBeNull());
      expect(api.calls).toContain('DELETE /api/messages/1');
    });

    it('返信が残っているメッセージを削除すると、「削除されました」の親になり、返信数が残る', async () => {
      renderChannel('c1', {
        ...base,
        'GET /api/channels/c1/messages': page(own(1, '親', { replyCount: 2 })),
        'DELETE /api/messages/1': done,
      });
      await screen.findByText('親');
      fireEvent.click(screen.getByRole('button', { name: '削除' }));
      fireEvent.click(screen.getByRole('button', { name: '削除する' }));
      await screen.findByText(/このメッセージは、削除されました。/);
      expect(screen.getByRole('button', { name: '返信 2 件' })).toBeTruthy();
    });
  });

  describe('スレッドとリアクション(FR-105, 108)', () => {
    const parentMsg = (extra: Partial<MessageResponse> = {}) => ({
      ...message(1, '親の本文', 'u9'),
      replyCount: 2,
      ...extra,
    });
    const reply = (id: number, body: string, authorId = 'u9'): MessageResponse => ({
      ...message(id, body, authorId),
      parentId: 1,
    });
    const listApi = (...items: unknown[]) => ({
      ...base,
      'GET /api/channels/c1/messages': () => json(200, { messages: items, nextCursor: null }),
    });

    it('「返信 N 件」でスレッドのパネルを開き、親と返信(古い順)を表示する。閉じられる', async () => {
      renderChannel('c1', {
        ...listApi(parentMsg()),
        'GET /api/messages/1/replies': () =>
          json(200, {
            parent: parentMsg(),
            replies: [reply(2, '返信一'), reply(3, '返信二')],
            nextCursor: null,
          }),
      });
      fireEvent.click(await screen.findByRole('button', { name: '返信 2 件' }));
      const panel = await screen.findByRole('complementary', { name: 'スレッド' });
      const replies = await within(panel).findByRole('list', { name: '返信一覧' });
      expect(
        within(replies)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([expect.stringContaining('返信一'), expect.stringContaining('返信二')]);
      expect(within(panel).getByText('親の本文')).toBeTruthy();
      fireEvent.click(within(panel).getByRole('button', { name: '閉じる' }));
      expect(screen.queryByRole('complementary', { name: 'スレッド' })).toBeNull();
    });

    it('返信を投稿すると、一覧に加わり、親の返信数が増える', async () => {
      const api = renderChannel('c1', {
        ...listApi(parentMsg()),
        'GET /api/messages/1/replies': () =>
          json(200, { parent: parentMsg(), replies: [reply(2, '返信一')], nextCursor: null }),
        'POST /api/messages/1/replies': ({ body }) => {
          expect(body).toEqual({ body: '新しい返信' });
          return json(201, reply(4, '新しい返信', 'u1'));
        },
      });
      fireEvent.click(await screen.findByRole('button', { name: '返信 2 件' }));
      const panel = await screen.findByRole('complementary', { name: 'スレッド' });
      await within(panel).findByText('返信一');
      fireEvent.change(within(panel).getByLabelText('返信'), { target: { value: '新しい返信' } });
      fireEvent.click(within(panel).getByRole('button', { name: '送信' }));
      await within(within(panel).getByRole('list', { name: '返信一覧' })).findByText('新しい返信');
      expect(within(panel).getByText('返信 3 件')).toBeTruthy();
      expect(api.calls).toContain('POST /api/messages/1/replies');
    });

    it('親が削除済みなら、「削除されました」と表示して、返信は残る。返信の投稿欄は出ない', async () => {
      const deletedParent = {
        id: 1,
        channelId: 'c1',
        createdAt: '2026-01-01T09:00:00.000Z',
        replyCount: 1,
        deleted: true,
      };
      renderChannel('c1', {
        ...listApi(deletedParent),
        'GET /api/messages/1/replies': () =>
          json(200, { parent: deletedParent, replies: [reply(2, '残った返信')], nextCursor: null }),
      });
      fireEvent.click(await screen.findByRole('button', { name: '返信 1 件' }));
      const panel = await screen.findByRole('complementary', { name: 'スレッド' });
      await within(panel).findByText('残った返信');
      expect(within(panel).getByText(/このメッセージは、削除されました。/)).toBeTruthy();
      expect(within(panel).queryByLabelText('返信')).toBeNull();
    });

    it('リアクションを付けると、件数が増え、自分のものは強調される。もう一度押すと解除される', async () => {
      const calls: string[] = [];
      renderChannel('c1', {
        ...listApi({ ...message(1, '本文', 'u9'), replyCount: 0 }),
        'PUT /api/messages/1/reactions/%F0%9F%9A%80': () => {
          calls.push('PUT');
          return json(200, { emoji: '🚀', count: 1, userIds: ['u1'] });
        },
        'DELETE /api/messages/1/reactions/%F0%9F%9A%80': () => {
          calls.push('DELETE');
          return new Response(null, { status: 204 });
        },
      });
      await screen.findByText('本文');
      fireEvent.click(screen.getByRole('button', { name: 'リアクションを追加' }));
      fireEvent.click(screen.getByRole('button', { name: '🚀' }));
      const chip = await screen.findByRole('button', { name: '🚀 1' });
      expect(chip.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(chip);
      await waitFor(() => expect(screen.queryByRole('button', { name: '🚀 1' })).toBeNull());
      expect(calls).toEqual(['PUT', 'DELETE']);
    });
  });

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
