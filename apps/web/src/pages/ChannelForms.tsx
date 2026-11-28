import { CHANNEL_NAME_MAX_LENGTH } from '@raisechat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  channelsKey,
  createChannel,
  joinChannel,
  joinableKey,
  listChannels,
  listJoinableChannels,
} from '../api/channels';
import { errorMessage } from '../api/client';
import { channelLabel } from './channel-label';
import { useCurrentWorkspace } from './WorkspaceShell';

/** チャンネルの作成(FR-202): 名前と種類(パブリック・プライベート)。作成したら、そのチャンネルを開く */
export function NewChannelPage() {
  const workspace = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');

  const create = useMutation({
    mutationFn: () => createChannel(workspace.id, { name, type }),
    onSuccess: async (channel) => {
      await queryClient.invalidateQueries({ queryKey: channelsKey(workspace.id) });
      void navigate(`/w/${workspace.id}/c/${channel.id}`);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <main>
      <h2>チャンネルを作成</h2>
      <form onSubmit={onSubmit}>
        <label>
          チャンネル名
          <input
            name="channelName"
            required
            maxLength={CHANNEL_NAME_MAX_LENGTH * 2}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          種類
          <select
            name="channelType"
            value={type}
            onChange={(e) => setType(e.target.value as 'public' | 'private')}
          >
            <option value="public"># パブリック(メンバーなら、だれでも参加できる)</option>
            <option value="private">🔒 プライベート(招待された人だけ)</option>
          </select>
        </label>
        {create.isError && <p role="alert">{errorMessage(create.error)}</p>}
        <button type="submit" disabled={create.isPending}>
          作成
        </button>
      </form>
    </main>
  );
}

/** 未参加のパブリックチャンネルの一覧と、参加(FR-203) */
export function BrowseChannelsPage() {
  const workspace = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const list = useQuery({
    queryKey: joinableKey(workspace.id),
    queryFn: ({ signal }) => listJoinableChannels(workspace.id, signal),
    retry: false,
  });

  const join = useMutation({
    mutationFn: (channelId: string) => joinChannel(channelId),
    onSuccess: async (channel) => {
      await queryClient.invalidateQueries({ queryKey: channelsKey(workspace.id) });
      void navigate(`/w/${workspace.id}/c/${channel.id}`);
    },
  });

  return (
    <main>
      <h2>チャンネルを探す</h2>
      {list.isPending && <p role="status">読み込み中…</p>}
      {list.isError && <p role="alert">{errorMessage(list.error)}</p>}
      {join.isError && <p role="alert">{errorMessage(join.error)}</p>}
      {list.data && list.data.length === 0 && <p>参加できるチャンネルは、ありません。</p>}
      <ul aria-label="参加できるチャンネル">
        {list.data?.map((c) => (
          <li key={c.id}>
            {channelLabel(c)}{' '}
            <button type="button" disabled={join.isPending} onClick={() => join.mutate(c.id)}>
              参加
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** ワークスペースを開いたとき: 既定のチャンネル(general)へ移る */
export function WorkspaceIndex() {
  const workspace = useCurrentWorkspace();
  const channels = useQuery({
    queryKey: channelsKey(workspace.id),
    queryFn: ({ signal }) => listChannels(workspace.id, signal),
    retry: false,
  });
  if (channels.isPending) return <p role="status">読み込み中…</p>;
  if (channels.isError) return <p role="alert">{errorMessage(channels.error)}</p>;
  const target = channels.data.find((c) => c.isDefault) ?? channels.data[0];
  if (!target) {
    return (
      <main>
        <p>参加しているチャンネルは、ありません。</p>
      </main>
    );
  }
  return <Navigate to={`/w/${workspace.id}/c/${target.id}`} replace />;
}
