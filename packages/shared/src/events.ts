import type { ChannelMemberResponse, ChannelResponse } from './channel';
import type { MessageResponse } from './message';
import type { MemberResponse, WorkspaceResponse } from './workspace';

/** user:updated のペイロード(表示名・アバター・ステータスの変更。FR-004) */
export interface UserUpdatedPayload {
  id: string;
  username: string;
  displayName: string;
  statusText: string;
  avatarUrl: string | null;
}

/**
 * サーバーからクライアントへのイベント(設計書 §6.4。フェーズ 2 の分)。
 * ペイロードは、REST の応答と同じ形にする。クライアントからサーバーへのイベントは、設けない(§6)。
 */
export interface ServerToClientEvents {
  'message:created': (message: MessageResponse) => void;
  'workspace:added': (workspace: WorkspaceResponse) => void;
  'member:joined': (payload: { workspaceId: string; member: MemberResponse }) => void;
  'channel:created': (channel: ChannelResponse) => void;
  'channel:added': (channel: ChannelResponse) => void;
  'channel:member-joined': (payload: { channelId: string; user: ChannelMemberResponse }) => void;
  'channel:left': (payload: { channelId: string }) => void;
  'channel:member-left': (payload: { channelId: string; userId: string }) => void;
  'user:updated': (user: UserUpdatedPayload) => void;
}

/** クライアントからサーバーへ送るイベントは、ない */
export type ClientToServerEvents = Record<string, never>;
