// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, mockApi } from '../test/mock-api';
import { InvitePage } from './InvitePage';

const TOKEN = 'T'.repeat(43);
const ME = { id: 'u1', username: 'taro', displayName: '太郎', statusText: '', avatarUrl: null };

function Where({ label }: { label: string }) {
  const location = useLocation();
  return (
    <p data-testid="where">
      {label}:{location.pathname}
      {location.search}
    </p>
  );
}

function renderInvite() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/invite/${TOKEN}`]}>
        <Routes>
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/login" element={<Where label="login" />} />
          <Route path="/w/:id" element={<Where label="workspace" />} />
          <Route path="/" element={<Where label="home" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InvitePage(招待リンクの受諾。FR-301)', () => {
  it('未ログインなら、ログイン画面へ移す。戻り先(?next=)に、この招待のパスを引き継ぐ', async () => {
    const api = mockApi({ 'GET /api/me': () => apiError(401, 'unauthorized') });
    renderInvite();
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(
        `login:/login?next=${encodeURIComponent(`/invite/${TOKEN}`)}`,
      ),
    );
    // 未ログインでは、招待の確認も、受諾も、呼ばない(無効な試行として数えられないように)
    expect(api.calls).toEqual(['GET /api/me']);
  });

  it('ログイン済みなら、ワークスペース名を示し、「参加する」で受諾して、そのワークスペースへ移る', async () => {
    const api = mockApi({
      'GET /api/me': () => json(200, ME),
      [`GET /api/invitations/${TOKEN}`]: () => json(200, { workspaceName: 'みんなの部屋' }),
      [`POST /api/invitations/${TOKEN}/accept`]: () =>
        json(200, { id: 'ws-1', name: 'みんなの部屋', role: 'member' }),
      'GET /api/workspaces': () => json(200, []),
    });
    renderInvite();
    expect(await screen.findByText('みんなの部屋')).toBeTruthy();
    // 確認しただけでは、参加しない
    expect(api.calls).not.toContain(`POST /api/invitations/${TOKEN}/accept`);

    screen.getByRole('button', { name: '参加する' }).click();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('workspace:/w/ws-1'));
    expect(api.calls).toContain(`POST /api/invitations/${TOKEN}/accept`);
    // 次回のホームでも、参加したワークスペースを開く
    expect(window.localStorage.getItem('raisechat:lastWorkspace')).toBe('ws-1');
  });

  it('無効なリンク(404)は、理由を区別せず、無効と案内する。参加のボタンは出さない', async () => {
    mockApi({
      'GET /api/me': () => json(200, ME),
      [`GET /api/invitations/${TOKEN}`]: () =>
        apiError(404, 'invalid_invitation', 'この招待リンクは、無効です。'),
    });
    renderInvite();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('この招待リンクは、無効です');
    expect(screen.queryByRole('button', { name: '参加する' })).toBeNull();
  });

  it('試行が多すぎる(429)ときは、時間をおくよう案内する', async () => {
    mockApi({
      'GET /api/me': () => json(200, ME),
      [`GET /api/invitations/${TOKEN}`]: () => apiError(429, 'rate_limited'),
    });
    renderInvite();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('しばらくしてから');
  });

  it('受諾に失敗したら、エラーを示し、その場にとどまる', async () => {
    mockApi({
      'GET /api/me': () => json(200, ME),
      [`GET /api/invitations/${TOKEN}`]: () => json(200, { workspaceName: '部屋' }),
      [`POST /api/invitations/${TOKEN}/accept`]: () =>
        apiError(404, 'invalid_invitation', 'この招待リンクは、無効です。'),
    });
    renderInvite();
    await screen.findByText('部屋');
    screen.getByRole('button', { name: '参加する' }).click();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('無効です');
    expect(screen.queryByTestId('where')).toBeNull();
  });
});
