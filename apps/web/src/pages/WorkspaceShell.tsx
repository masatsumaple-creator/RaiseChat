import type { WorkspaceResponse } from '@raisechat/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getWorkspace, useWorkspaces, workspaceKey } from '../api/workspaces';
import { clearLastWorkspace, getLastWorkspace, setLastWorkspace } from '../auth/last-workspace';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** 子の画面(メンバー一覧・招待の管理)が、いま開いているワークスペースを取り出す */
export function useCurrentWorkspace(): WorkspaceResponse {
  return useOutletContext<WorkspaceResponse>();
}

/** ワークスペースの共通部分: 左に切り替え、右に中身(/w/:wsId の子の画面) */
export function WorkspaceShell() {
  const { wsId } = useParams();
  const workspace = useQuery({
    queryKey: workspaceKey(wsId ?? ''),
    queryFn: ({ signal }) => getWorkspace(wsId!, signal),
    enabled: wsId !== undefined,
    retry: false,
  });
  const workspaces = useWorkspaces();

  useEffect(() => {
    if (!wsId) return;
    if (workspace.isSuccess) setLastWorkspace(wsId);
    // 見つからない・利用できない(キックされた、など)ワークスペースは、次回から開かない
    if (workspace.error instanceof ApiError && [403, 404].includes(workspace.error.status)) {
      if (getLastWorkspace() === wsId) clearLastWorkspace();
    }
  }, [wsId, workspace.isSuccess, workspace.error]);

  const unavailable =
    workspace.error instanceof ApiError &&
    (workspace.error.status === 404 || workspace.error.status === 403);

  return (
    <div className="workspace-layout">
      <aside>
        {workspaces.data ? (
          <WorkspaceSwitcher workspaces={workspaces.data} currentId={wsId} />
        ) : null}
      </aside>
      <section>
        {workspace.isPending ? (
          <p role="status">読み込み中…</p>
        ) : workspace.isError ? (
          <div role="alert">
            {unavailable ? (
              <p>このワークスペースは、利用できません。</p>
            ) : (
              <>
                <p>ワークスペースを取得できません。</p>
                <button type="button" onClick={() => void workspace.refetch()}>
                  再試行
                </button>
              </>
            )}
            <Link to="/">ホームへ</Link>
          </div>
        ) : (
          <>
            <h1>{workspace.data.name}</h1>
            <Outlet context={workspace.data} />
          </>
        )}
      </section>
    </div>
  );
}
