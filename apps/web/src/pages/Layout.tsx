import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router-dom';
import { logout } from '../api/auth';
import { errorMessage } from '../api/client';
import { ME_QUERY_KEY, useMe } from '../api/me';
import { RealtimeProvider, useConnectionStatus } from '../chat/realtime';

/** WebSocket が切れている間だけ、画面で知らせる(自動で再接続する) */
function ConnectionBanner() {
  const status = useConnectionStatus();
  if (status !== 'disconnected') return null;
  return (
    <p role="status" className="connection-banner">
      接続が切れました。再接続しています…
    </p>
  );
}

/** ログイン済みの画面の共通部分(ヘッダー: ホームへ・プロフィール・ログアウト)。WebSocket もここでつなぐ */
export function Layout() {
  const queryClient = useQueryClient();
  const { data: me } = useMe();

  const mutation = useMutation({
    mutationFn: logout,
    // 未ログインになると、RequireAuth が、ログイン画面へ移す
    onSuccess: () => queryClient.setQueryData(ME_QUERY_KEY, null),
  });

  return (
    <RealtimeProvider>
      <header>
        <Link to="/">RaiseChat</Link>
        <nav>
          <Link to="/profile">{me?.displayName ?? 'プロフィール'}</Link>
          <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            ログアウト
          </button>
        </nav>
        {mutation.isError && <p role="alert">{errorMessage(mutation.error)}</p>}
      </header>
      <ConnectionBanner />
      <Outlet />
    </RealtimeProvider>
  );
}
