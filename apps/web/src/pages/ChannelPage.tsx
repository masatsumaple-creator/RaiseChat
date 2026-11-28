import type { ChannelResponse } from '@raisechat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addChannelMember,
  channelMembersKey,
  channelsKey,
  leaveChannel,
  listChannelMembers,
  listChannels,
} from '../api/channels';
import { errorMessage } from '../api/client';
import { useMe } from '../api/me';
import { listMembers, membersKey } from '../api/workspaces';
import { MessageList } from '../chat/MessageList';
import { ThreadPanel } from '../chat/ThreadPanel';
import { channelLabel } from './channel-label';
import { useCurrentWorkspace } from './WorkspaceShell';

/** 参加者の一覧と、プライベートチャンネルへの招待(作成者かオーナーだけ。FR-204) */
function ParticipantsPanel({ channel }: { channel: ChannelResponse }) {
  const workspace = useCurrentWorkspace();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');

  const participants = useQuery({
    queryKey: channelMembersKey(channel.id),
    queryFn: ({ signal }) => listChannelMembers(channel.id, signal),
    retry: false,
  });
  const canInvite =
    channel.type === 'private' && (workspace.role === 'owner' || channel.createdBy === me?.id);
  const workspaceMembers = useQuery({
    queryKey: membersKey(workspace.id),
    queryFn: ({ signal }) => listMembers(workspace.id, signal),
    enabled: canInvite,
    retry: false,
  });

  const invite = useMutation({
    mutationFn: (userId: string) => addChannelMember(channel.id, userId),
    onSuccess: async () => {
      setSelected('');
      await queryClient.invalidateQueries({ queryKey: channelMembersKey(channel.id) });
    },
  });

  const participantIds = new Set(participants.data?.map((p) => p.id));
  const candidates = (workspaceMembers.data ?? []).filter((m) => !participantIds.has(m.id));

  return (
    <details>
      <summary>参加者({participants.data?.length ?? '…'})</summary>
      {participants.isError && <p role="alert">{errorMessage(participants.error)}</p>}
      <ul aria-label="参加者">
        {participants.data?.map((p) => (
          <li key={p.id}>
            {p.displayName}(@{p.username})
          </li>
        ))}
      </ul>
      {canInvite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (selected) invite.mutate(selected);
          }}
        >
          <label>
            招待する人
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">選んでください</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}(@{m.username})
                </option>
              ))}
            </select>
          </label>
          {invite.isError && <p role="alert">{errorMessage(invite.error)}</p>}
          <button type="submit" disabled={!selected || invite.isPending}>
            招待
          </button>
        </form>
      )}
    </details>
  );
}

/** チャンネルの画面: ヘッダー(名前・退出)、メッセージ、入力欄、参加者 */
export function ChannelPage() {
  const { chId } = useParams();
  const workspace = useCurrentWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // 開いているスレッドの親(チャンネルを移ると、閉じる)
  const [thread, setThread] = useState<{ channelId: string; rootId: number } | null>(null);

  const channels = useQuery({
    queryKey: channelsKey(workspace.id),
    queryFn: ({ signal }) => listChannels(workspace.id, signal),
    retry: false,
  });
  const channel = channels.data?.find((c) => c.id === chId);

  const leave = useMutation({
    mutationFn: () => leaveChannel(chId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: channelsKey(workspace.id) });
      void navigate(`/w/${workspace.id}`, { replace: true });
    },
  });

  if (channels.isPending) return <p role="status">読み込み中…</p>;
  if (channels.isError) return <p role="alert">{errorMessage(channels.error)}</p>;
  // 参加していない・存在しないチャンネルは、区別せず、同じ案内にする(存在を隠す)
  if (!channel || !chId) {
    return (
      <main>
        <p role="alert">このチャンネルは、見つかりません。</p>
        <Link to={`/w/${workspace.id}/channels/browse`}>チャンネルを探す</Link>
      </main>
    );
  }

  return (
    <main className="channel">
      <header className="channel-header">
        <h2>{channelLabel(channel)}</h2>
        {!channel.isDefault && (
          <button type="button" disabled={leave.isPending} onClick={() => leave.mutate()}>
            退出
          </button>
        )}
        {leave.isError && <p role="alert">{errorMessage(leave.error)}</p>}
      </header>
      <ParticipantsPanel key={channel.id} channel={channel} />
      <div className="channel-body">
        <MessageList
          key={channel.id}
          channelId={channel.id}
          onOpenThread={(rootId) => setThread({ channelId: channel.id, rootId })}
        />
        {thread?.channelId === channel.id && (
          <ThreadPanel
            key={thread.rootId}
            channelId={channel.id}
            rootId={thread.rootId}
            onClose={() => setThread(null)}
          />
        )}
      </div>
    </main>
  );
}
