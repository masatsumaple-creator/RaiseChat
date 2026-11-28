import type {
  ChannelMemberResponse,
  ChannelResponse,
  CreateChannelRequest,
  MessagePageResponse,
  MessageResponse,
} from '@raisechat/shared';
import { apiFetch } from './client';

/** クエリのキー。先頭の値で、まとめて無効化できる(['channels'] なら、すべてのチャンネル一覧) */
export const channelsKey = (workspaceId: string) => ['channels', workspaceId] as const;
export const joinableKey = (workspaceId: string) => ['channels', workspaceId, 'joinable'] as const;
export const channelMembersKey = (channelId: string) => ['channel-members', channelId] as const;
export const messagesKey = (channelId: string) => ['messages', channelId] as const;

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

export const listChannelMembers = (channelId: string, signal?: AbortSignal) =>
  apiFetch<ChannelMemberResponse[]>(`/api/channels/${channelId}/members`, { signal });

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
