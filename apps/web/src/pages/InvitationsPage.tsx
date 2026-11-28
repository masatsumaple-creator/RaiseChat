import type { InvitationStatus } from '@raisechat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client';
import {
  createInvitation,
  invitationsKey,
  listInvitations,
  revokeInvitation,
} from '../api/workspaces';
import { useCurrentWorkspace } from './WorkspaceShell';

const STATUS_LABEL: Record<InvitationStatus, string> = {
  active: '有効',
  expired: '期限切れ',
  revoked: '取り消し済み',
  exhausted: '回数超過',
};

/** 招待リンクの URL。トークンは、発行の応答でだけ分かる */
export function invitationUrl(origin: string, token: string): string {
  return `${origin}/invite/${token}`;
}

/** 招待リンクの発行・一覧・取り消し(FR-301。オーナーのみ) */
export function InvitationsPage() {
  const workspace = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const [expiresInDays, setExpiresInDays] = useState<1 | 7 | 30>(7);
  const [maxUses, setMaxUses] = useState<1 | 10 | 'unlimited'>(10);
  // 発行した直後のリンク(トークンは、この画面にしか残らない)
  const [issued, setIssued] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const isOwner = workspace.role === 'owner';
  const list = useQuery({
    queryKey: invitationsKey(workspace.id),
    queryFn: ({ signal }) => listInvitations(workspace.id, signal),
    enabled: isOwner,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => createInvitation(workspace.id, { expiresInDays, maxUses }),
    onSuccess: async (created) => {
      setIssued(invitationUrl(window.location.origin, created.token));
      setCopyFailed(false);
      await queryClient.invalidateQueries({ queryKey: invitationsKey(workspace.id) });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvitation(workspace.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey(workspace.id) }),
  });

  if (!isOwner) {
    return (
      <main>
        <p role="alert">招待リンクを管理できるのは、オーナーだけです。</p>
        <Link to="..">戻る</Link>
      </main>
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <main>
      <p>
        <Link to="..">戻る</Link>
      </p>
      <h2>招待リンク</h2>
      <form onSubmit={onSubmit}>
        <label>
          有効期限
          <select
            name="expiresInDays"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value) as 1 | 7 | 30)}
          >
            <option value={1}>1 日</option>
            <option value={7}>7 日</option>
            <option value={30}>30 日</option>
          </select>
        </label>
        <label>
          使用回数
          <select
            name="maxUses"
            value={String(maxUses)}
            onChange={(e) => {
              const v = e.target.value;
              setMaxUses(v === 'unlimited' ? 'unlimited' : (Number(v) as 1 | 10));
            }}
          >
            <option value="1">1 回</option>
            <option value="10">10 回</option>
            <option value="unlimited">無制限</option>
          </select>
        </label>
        {create.isError && <p role="alert">{errorMessage(create.error)}</p>}
        <button type="submit" disabled={create.isPending}>
          リンクを発行
        </button>
      </form>

      {issued && (
        <div role="status" aria-label="発行したリンク">
          <p>
            <strong>このリンクが表示されるのは、今回だけです。</strong>
            コピーして、招待したい人に送ってください。
          </p>
          <p>
            <code data-testid="issued-link">{issued}</code>
          </p>
          <button type="button" onClick={() => void copy()}>
            コピー
          </button>
          {copyFailed && <p role="alert">コピーできませんでした。手で書き写してください。</p>}
        </div>
      )}

      <h3>発行済みのリンク</h3>
      {list.isPending && <p role="status">読み込み中…</p>}
      {list.isError && <p role="alert">{errorMessage(list.error)}</p>}
      {revoke.isError && <p role="alert">{errorMessage(revoke.error)}</p>}
      {list.data && list.data.length === 0 && <p>発行済みのリンクは、ありません。</p>}
      {list.data && list.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>状態</th>
              <th>期限</th>
              <th>使用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((inv) => (
              <tr key={inv.id}>
                <td>{STATUS_LABEL[inv.status]}</td>
                <td>{new Date(inv.expiresAt).toLocaleString('ja-JP')}</td>
                <td>
                  {inv.usedCount} / {inv.maxUses ?? '無制限'}
                </td>
                <td>
                  {inv.status === 'active' && (
                    <button
                      type="button"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(inv.id)}
                    >
                      取り消す
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
