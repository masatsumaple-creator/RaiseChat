// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, mockApi } from '../test/mock-api';
import { HomePage } from './HomePage';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceShell } from './WorkspaceShell';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const ME = { id: 'u1', username: 'taro', displayName: '太郎', statusText: '', avatarUrl: null };
const A = { id: 'ws-a', name: '開発チーム', role: 'owner' as const };
const B = { id: 'ws-b', name: '読書会', role: 'member' as const };

function Path() {
  const location = useLocation();
  return <p data-testid="path">{location.pathname}</p>;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkspaceSwitcher(FR-206)', () => {
  it('所属するワークスペースを一覧し、いま開いているものに aria-current を付ける。作成へのリンクもある', () => {
    render(
      <MemoryRouter>
        <WorkspaceSwitcher workspaces={[A, B]} currentId="ws-b" />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'ワークスペース' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['開発チーム', '/w/ws-a'],
      ['読書会', '/w/ws-b'],
      ['ワークスペースを作成', '/workspaces/new'],
    ]);
    expect(links[0]!.getAttribute('aria-current')).toBeNull();
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
  });
});

describe('ワークスペースの切り替え(WorkspaceShell)', () => {
  function renderShell(initial: string, extra: Record<string, () => Response> = {}) {
    const api = mockApi({
      'GET /api/workspaces': () => json(200, [A, B]),
      'GET /api/workspaces/ws-a': () => json(200, A),
      'GET /api/workspaces/ws-b': () => json(200, B),
      'GET /api/workspaces/ws-a/members': () => json(200, []),
      'GET /api/workspaces/ws-b/members': () => json(200, []),
      ...extra,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/w/:wsId" element={<WorkspaceShell />}>
              <Route index element={<WorkspaceHome />} />
            </Route>
            <Route path="/" element={<Path />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return api;
  }

  it('リンクで切り替えると、そのワークスペースの内容に変わる。最後に開いたものを覚える', async () => {
    renderShell('/w/ws-a');
    expect(await screen.findByRole('heading', { name: '開発チーム' })).toBeTruthy();
    expect(window.localStorage.getItem('raisechat:lastWorkspace')).toBe('ws-a');

    fireEvent.click(screen.getByRole('link', { name: '読書会' }));
    expect(await screen.findByRole('heading', { name: '読書会' })).toBeTruthy();
    await waitFor(() =>
      expect(window.localStorage.getItem('raisechat:lastWorkspace')).toBe('ws-b'),
    );
  });

  it('オーナーのワークスペースにだけ、招待リンクの管理へのリンクが出る', async () => {
    renderShell('/w/ws-a');
    await screen.findByRole('heading', { name: '開発チーム' });
    expect(await screen.findByRole('link', { name: '招待リンクの管理' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: '読書会' }));
    await screen.findByRole('heading', { name: '読書会' });
    expect(screen.queryByRole('link', { name: '招待リンクの管理' })).toBeNull();
  });

  it('利用できない(キックされた・存在しない)ワークスペースは、案内を出し、最後に開いたものから外す', async () => {
    window.localStorage.setItem('raisechat:lastWorkspace', 'ws-gone');
    renderShell('/w/ws-gone', {
      'GET /api/workspaces/ws-gone': () => apiError(403, 'forbidden'),
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('このワークスペースは、利用できません');
    await waitFor(() => expect(window.localStorage.getItem('raisechat:lastWorkspace')).toBeNull());
  });
});

describe('HomePage', () => {
  function renderHome() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/w/:id" element={<Path />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('ワークスペースがなければ、作成を案内する', async () => {
    mockApi({
      'GET /api/me': () => json(200, ME),
      'GET /api/workspaces': () => json(200, []),
    });
    renderHome();
    expect(await screen.findByRole('heading', { name: 'ようこそ、太郎さん' })).toBeTruthy();
    expect(screen.getByLabelText('ワークスペース名')).toBeTruthy();
  });

  it('最後に開いたワークスペースへ移る。なければ、最初のもの。消えていれば、最初のもの', async () => {
    mockApi({
      'GET /api/me': () => json(200, ME),
      'GET /api/workspaces': () => json(200, [A, B]),
    });
    window.localStorage.setItem('raisechat:lastWorkspace', 'ws-b');
    renderHome();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/w/ws-b'));
    cleanup();

    window.localStorage.clear();
    renderHome();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/w/ws-a'));
    cleanup();

    window.localStorage.setItem('raisechat:lastWorkspace', 'ws-removed');
    renderHome();
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/w/ws-a'));
  });

  it('作成すると、そのワークスペースへ移る(名前は、そのまま送る)', async () => {
    let sent: unknown;
    mockApi({
      'GET /api/me': () => json(200, ME),
      'GET /api/workspaces': () => json(200, []),
      'POST /api/workspaces': ({ body }) => {
        sent = body;
        return json(201, { id: 'ws-new', name: '新しい部屋', role: 'owner' });
      },
    });
    renderHome();
    const input = await screen.findByLabelText('ワークスペース名');
    fireEvent.change(input, { target: { value: '新しい部屋' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/w/ws-new'));
    expect(sent).toEqual({ name: '新しい部屋' });
  });

  it('作成に失敗したら、サーバーのメッセージを示す', async () => {
    mockApi({
      'GET /api/me': () => json(200, ME),
      'GET /api/workspaces': () => json(200, []),
      'POST /api/workspaces': () => apiError(400, 'validation_error', '名前を入力してください'),
    });
    renderHome();
    fireEvent.change(await screen.findByLabelText('ワークスペース名'), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect((await screen.findByRole('alert')).textContent).toContain('名前を入力してください');
  });
});
