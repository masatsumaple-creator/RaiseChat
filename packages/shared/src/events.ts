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
  /** トップレベルのメッセージの編集 */
  'message:updated': (message: MessageResponse) => void;
  /** トップレベルのメッセージの削除(本文は含まない)。返信が残っていれば、画面は「削除されました」と表示する */
  'message:deleted': (payload: { id: number; channelId: string; replyCount: number }) => void;
  /** スレッドの返信の投稿。親の返信数(この返信を含む)つき。トップレベルの message:created は送らない */
  'thread:reply-created': (payload: { reply: MessageResponse; replyCount: number }) => void;
  /** スレッドの返信の編集(返信の編集・削除では、message:* は送らない。設計書 §10 の T17) */
  'thread:reply-updated': (message: MessageResponse) => void;
  /** スレッドの返信の削除(本文は含まない)。親の返信数つき */
  'thread:reply-deleted': (payload: {
    id: number;
    channelId: string;
    parentId: number;
    replyCount: number;
  }) => void;
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
