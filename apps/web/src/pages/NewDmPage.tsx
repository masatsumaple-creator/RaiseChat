import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { channelsKey, createDm } from '../api/channels';
import { errorMessage } from '../api/client';
import { useMe } from '../api/me';
import { listMembers, membersKey } from '../api/workspaces';
import { useCurrentWorkspace } from './WorkspaceShell';

/**
 * DM を始める(FR-102)。ワークスペースのメンバー一覧から、相手を選ぶ(自分自身は出さない)。
 * すでに DM があれば、サーバーは、それを返す。作成したら(または、あれば)、その DM を開く。
 */
export function NewDmPage() {
  const workspace = useCurrentWorkspace();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const members = useQuery({
    queryKey: membersKey(workspace.id),
    queryFn: ({ signal }) => listMembers(workspace.id, signal),
    retry: false,
  });

  const start = useMutation({
    mutationFn: (userId: string) => createDm(workspace.id, userId),
    onSuccess: async (channel) => {
      await queryClient.invalidateQueries({ queryKey: channelsKey(workspace.id) });
      void navigate(`/w/${workspace.id}/c/${channel.id}`);
    },
  });

  const others = (members.data ?? []).filter((m) => m.id !== me?.id);

  return (
    <main>
      <h2>ダイレクトメッセージを始める</h2>
      {members.isPending && <p role="status">読み込み中…</p>}
      {members.isError && <p role="alert">{errorMessage(members.error)}</p>}
      {members.data && others.length === 0 && <p>ほかのメンバーは、まだ、いません。</p>}
      {start.isError && <p role="alert">{errorMessage(start.error)}</p>}
      <ul aria-label="相手を選ぶ">
        {others.map((m) => (
          <li key={m.id}>
            <button type="button" disabled={start.isPending} onClick={() => start.mutate(m.id)}>
              {m.displayName}(@{m.username})
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
