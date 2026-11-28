import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../api/me';
import { safeNext } from './next';
import { usePendingRecovery } from './pending-recovery';

/** 認証の状態の取得中・失敗の表示。ログイン済みか否かが分かるまで、どちらの画面も出さない */
function AuthGate({ children }: { children: (loggedIn: boolean) => ReactNode }) {
  const { data, isPending, isError, refetch } = useMe();
  if (isPending) return <p role="status">読み込み中…</p>;
  if (isError) {
    return (
      <div role="alert">
        <p>サーバーに接続できません。</p>
        <button type="button" onClick={() => void refetch()}>
          再試行
        </button>
      </div>
    );
  }
  return <>{children(data !== null)}</>;
}

/** ログイン済みの人だけが見られる画面。未ログインなら /login へ */
export function RequireAuth() {
  return (
    <AuthGate>{(loggedIn) => (loggedIn ? <Outlet /> : <Navigate to="/login" replace />)}</AuthGate>
  );
}

/** ログイン前の画面(ログイン・登録)。ログイン済みなら、ホームへ */
export function PublicOnly() {
  const { pending } = usePendingRecovery();
  // ログイン後は、?next= があれば(招待リンクなど)そこへ戻る。なければホーム
  const next = safeNext(useLocation().search) ?? '/';
  return (
    <AuthGate>
      {(loggedIn) =>
        // リカバリーコードの保存の確認が済むまでは、ログイン済みでも、登録の画面にとどめる
        loggedIn && !pending ? <Navigate to={next} replace /> : <Outlet />
      }
    </AuthGate>
  );
}
