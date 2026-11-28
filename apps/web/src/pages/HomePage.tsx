import { Navigate } from 'react-router-dom';
import { useMe } from '../api/me';
import { useWorkspaces } from '../api/workspaces';
import { getLastWorkspace } from '../auth/last-workspace';
import { CreateWorkspaceForm } from './CreateWorkspaceForm';

/**
 * ホーム。所属するワークスペースがあれば、最後に開いたもの(なければ最初のもの)へ移る。
 * なければ、ワークスペースの作成を案内する。
 */
export function HomePage() {
  const { data: me } = useMe();
  const workspaces = useWorkspaces();

  if (workspaces.isPending) return <p role="status">読み込み中…</p>;
  if (workspaces.isError) {
    return (
      <div role="alert">
        <p>ワークスペースを取得できません。</p>
        <button type="button" onClick={() => void workspaces.refetch()}>
          再試行
        </button>
      </div>
    );
  }

  const list = workspaces.data;
  if (list.length > 0) {
    const last = getLastWorkspace();
    const target = list.find((w) => w.id === last) ?? list[0]!;
    return <Navigate to={`/w/${target.id}`} replace />;
  }

  return (
    <main>
      <h1>ようこそ、{me?.displayName}さん</h1>
      <p>
        まだ、どのワークスペースにも参加していません。新しく作るか、招待リンクを受け取って参加してください。
      </p>
      <h2>ワークスペースを作成</h2>
      <CreateWorkspaceForm />
    </main>
  );
}

export function NewWorkspacePage() {
  return (
    <main>
      <h1>ワークスペースを作成</h1>
      <CreateWorkspaceForm />
    </main>
  );
}
