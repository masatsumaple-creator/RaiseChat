import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { useMe } from '../api/me';
import { acceptInvitation, previewInvitation, WORKSPACES_KEY } from '../api/workspaces';
import { setLastWorkspace } from '../auth/last-workspace';
import { withNext } from '../auth/next';

/** 招待リンクの受諾(FR-301)。確認してから、ボタンで参加する */
function InviteAccept({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: ({ signal }) => previewInvitation(token, signal),
    // 無効なトークンの試行は、数えられる(レート制限)ため、自動で取り直さない
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const accept = useMutation({
    mutationFn: () => acceptInvitation(token),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
      setLastWorkspace(workspace.id);
      void navigate(`/w/${workspace.id}`, { replace: true });
    },
  });

  if (preview.isPending) return <p role="status">確認しています…</p>;

  if (preview.isError) {
    const error = preview.error;
    const rateLimited = error instanceof ApiError && error.status === 429;
    return (
      <main>
        <h1>招待リンク</h1>
        <p role="alert">
          {rateLimited
            ? 'しばらくしてから、もう一度お試しください。'
            : error instanceof ApiError && error.status === 404
              ? 'この招待リンクは、無効です。期限が切れたか、取り消されたか、使用回数の上限に達した可能性があります。招待した人に、新しいリンクを頼んでください。'
              : errorMessage(error)}
        </p>
        <Link to="/">ホームへ</Link>
      </main>
    );
  }

  return (
    <main>
      <h1>招待リンク</h1>
      <p>
        「<strong>{preview.data.workspaceName}</strong>」に招待されています。
      </p>
      {accept.isError && <p role="alert">{errorMessage(accept.error)}</p>}
      <button type="button" disabled={accept.isPending} onClick={() => accept.mutate()}>
        参加する
      </button>
    </main>
  );
}

/**
 * /invite/:token。受諾にはログインが必須(FR-301)。
 * 未ログインなら、ログイン画面へ移し(登録もできる)、ログインの後に、この画面へ戻る。
 */
export function InvitePage() {
  const { token } = useParams();
  const me = useMe();

  if (!token) return <Navigate to="/" replace />;
  if (me.isPending) return <p role="status">読み込み中…</p>;
  if (me.isError) {
    return (
      <div role="alert">
        <p>サーバーに接続できません。</p>
        <button type="button" onClick={() => void me.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  if (me.data === null) {
    return <Navigate to={withNext('/login', `/invite/${token}`)} replace />;
  }
  return <InviteAccept token={token} />;
}
