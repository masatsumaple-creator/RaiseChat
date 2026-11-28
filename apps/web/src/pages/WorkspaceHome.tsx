import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { listMembers, membersKey } from '../api/workspaces';
import { useCurrentWorkspace } from './WorkspaceShell';

/** ワークスペースの最初の画面: メンバー一覧(チャンネルは、T16 で足す) */
export function WorkspaceHome() {
  const workspace = useCurrentWorkspace();
  const members = useQuery({
    queryKey: membersKey(workspace.id),
    queryFn: ({ signal }) => listMembers(workspace.id, signal),
    retry: false,
  });

  return (
    <main>
      {workspace.role === 'owner' && (
        <p>
          <Link to="invitations">招待リンクの管理</Link>
        </p>
      )}
      <h2>メンバー</h2>
      {members.isPending && <p role="status">読み込み中…</p>}
      {members.isError && <p role="alert">{errorMessage(members.error)}</p>}
      {members.data && (
        <ul aria-label="メンバー">
          {members.data.map((m) => (
            <li key={m.id}>
              {m.avatarUrl && <img src={m.avatarUrl} alt="" width={24} height={24} />}
              {m.displayName}(@{m.username}){m.role === 'owner' ? ' オーナー' : ''}
              {m.statusText ? ` — ${m.statusText}` : ''}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
