import type {
  ChannelMemberResponse,
  ChannelResponse,
  CreateChannelRequest,
  MessagePageResponse,
  MessageResponse,
  ReactionSummary,
  ReplyPageResponse,
} from '@raisechat/shared';
import { apiFetch } from './client';

/** クエリのキー。先頭の値で、まとめて無効化できる(['channels'] なら、すべてのチャンネル一覧) */
export const channelsKey = (workspaceId: string) => ['channels', workspaceId] as const;
export const joinableKey = (workspaceId: string) => ['channels', workspaceId, 'joinable'] as const;
export const channelMembersKey = (channelId: string) => ['channel-members', channelId] as const;
export const messagesKey = (channelId: string) => ['messages', channelId] as const;
export const repliesKey = (rootId: number) => ['replies', rootId] as const;

export const listChannels = (workspaceId: string, signal?: AbortSignal) =>
  apiFetch<ChannelResponse[]>(`/api/workspaces/${workspaceId}/channels`, { signal });

/** 未参加のパブリックチャンネル(FR-203) */
export const listJoinableChannels = (workspaceId: string, signal?: AbortSignal) =>
  apiFetch<ChannelResponse[]>(`/api/workspaces/${workspaceId}/channels?joinable=1`, { signal });

export const createChannel = (workspaceId: string, request: CreateChannelRequest) =>
  apiFetch<ChannelResponse>(`/api/workspaces/${workspaceId}/channels`, {
    method: 'POST',
    json: request,
  });

export const joinChannel = (channelId: string) =>
  apiFetch<ChannelResponse>(`/api/channels/${channelId}/join`, { method: 'POST' });

export const leaveChannel = (channelId: string) =>
  apiFetch<void>(`/api/channels/${channelId}/leave`, { method: 'POST' });

/** q があれば、ユーザー名・表示名の前方一致で絞る(メンション候補。FR-109) */
export const listChannelMembers = (channelId: string, signal?: AbortSignal, q?: string) =>
  apiFetch<ChannelMemberResponse[]>(
    `/api/channels/${channelId}/members${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    { signal },
  );

export const createDm = (workspaceId: string, userId: string) =>
  apiFetch<ChannelResponse>(`/api/workspaces/${workspaceId}/dms`, {
    method: 'POST',
    json: { userId },
  });

export const addChannelMember = (channelId: string, userId: string) =>
  apiFetch<void>(`/api/channels/${channelId}/members`, { method: 'POST', json: { userId } });

/** 新しい順に 50 件。cursor は、前のページの最後の ID */
export const listMessages = (channelId: string, cursor: number | undefined, signal?: AbortSignal) =>
  apiFetch<MessagePageResponse>(
    `/api/channels/${channelId}/messages${cursor === undefined ? '' : `?cursor=${cursor}`}`,
    { signal },
  );

export const postMessage = (channelId: string, body: string) =>
  apiFetch<MessageResponse>(`/api/channels/${channelId}/messages`, {
    method: 'POST',
    json: { body },
  });

/** 自分のメッセージの編集(FR-103) */
export const editMessage = (messageId: number, body: string) =>
  apiFetch<MessageResponse>(`/api/messages/${messageId}`, { method: 'PATCH', json: { body } });

/** 自分のメッセージの削除(FR-104。論理削除) */
export const deleteMessage = (messageId: number) =>
  apiFetch<void>(`/api/messages/${messageId}`, { method: 'DELETE' });

/** スレッドの返信(古い順に 50 件ずつ)と親。cursor は、前のページの最後の ID */
export const listReplies = (rootId: number, cursor: number | undefined, signal?: AbortSignal) =>
  apiFetch<ReplyPageResponse>(
    `/api/messages/${rootId}/replies${cursor === undefined ? '' : `?cursor=${cursor}`}`,
    { signal },
  );

export const postReply = (rootId: number, body: string) =>
  apiFetch<MessageResponse>(`/api/messages/${rootId}/replies`, { method: 'POST', json: { body } });

/** リアクションの付与(冪等)。その絵文字の、いまの状態が返る */
export const addReaction = (messageId: number, emoji: string) =>
  apiFetch<ReactionSummary>(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'PUT',
  });

/** リアクションの解除(冪等) */
export const removeReaction = (messageId: number, emoji: string) =>
  apiFetch<void>(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  });
