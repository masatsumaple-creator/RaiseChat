import type { ServerToClientEvents } from '@raisechat/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { channelMembersKey, channelsKey, messagesKey } from '../api/channels';
import { ME_QUERY_KEY } from '../api/me';
import { membersKey, WORKSPACES_KEY } from '../api/workspaces';
import {
  addMessage,
  applyMessageDeleted,
  applyReaction,
  keepFirstPage,
  replaceMessage,
  setReplyCount,
  updateAuthor,
  type MessagesData,
} from './cache';
import {
  addReply,
  applyReactionToReplies,
  markParentDeleted,
  removeReply,
  replaceParent,
  replaceReply,
  updateReplyAuthor,
  type RepliesData,
} from './replies-cache';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const ConnectionContext = createContext<ConnectionStatus>('connecting');

/** WebSocket の接続の状態(切れているときに、画面で知らせるため) */
export function useConnectionStatus(): ConnectionStatus {
  return useContext(ConnectionContext);
}

/** サーバーに強制的に切られたあとに、つなぎ直すまでの待ち(ミリ秒) */
const RECONNECT_AFTER_SERVER_DISCONNECT_MS = 3000;

/**
 * 受信したイベントを、クエリのキャッシュに反映する(設計書 §6.4)。
 * 未読数は、フェーズ 5 で扱う。ここでは、一覧を取り直す(無効化する)か、メッセージを加えるだけにする。
 */
export function applyServerEvents(socket: Socket<ServerToClientEvents>, queryClient: QueryClient) {
  socket.on('message:created', (message) => {
    const key = messagesKey(message.channelId);
    if (queryClient.getQueryData<MessagesData>(key) === undefined) {
      // 一覧を取得している最中(チャンネルを開いた直後)かもしれない。その応答は、この投稿より前の状態を
      // 読んでいる可能性がある。データがまだないクエリは、無効化しても、進行中の取得が使い続けられる
      // (取り直されない)ため、先に取得を取り消してから、取り直す。
      // 開いていない(キャッシュがない)チャンネルは、何も起きない
      void queryClient
        .cancelQueries({ queryKey: key })
        .then(() => queryClient.invalidateQueries({ queryKey: key }));
      return;
    }
    // 冪等: 投稿の応答でも加えるため、同じ ID は加えない
    queryClient.setQueryData<MessagesData>(key, (data) => addMessage(data, message));
  });
  socket.on('message:updated', (message) => {
    // スレッドのパネルに開いている親も、置き換える
    queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
      replaceParent(data, message),
    );
    queryClient.setQueryData<MessagesData>(messagesKey(message.channelId), (data) =>
      replaceMessage(data, message),
    );
  });
  socket.on('message:deleted', ({ id, channelId, replyCount }) => {
    queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
      markParentDeleted(data, { id, replyCount }),
    );
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      applyMessageDeleted(data, { id, replyCount }),
    );
  });
  socket.on('thread:reply-created', ({ reply, replyCount }) => {
    if (reply.parentId === null) return;
    // 開いているスレッドのパネルにも、加える(冪等)
    queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
      addReply(data, reply, replyCount),
    );
    queryClient.setQueryData<MessagesData>(messagesKey(reply.channelId), (data) =>
      setReplyCount(data, reply.parentId!, replyCount),
    );
  });
  // 返信は、一覧に出ない。親の返信数だけを更新する(返信の一覧は、スレッドの画面で扱う)
  socket.on('thread:reply-updated', (reply) => {
    queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
      replaceReply(data, reply),
    );
  });
  socket.on('thread:reply-deleted', ({ id, channelId, parentId, replyCount }) => {
    queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
      removeReply(data, { id, parentId, replyCount }),
    );
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      setReplyCount(data, parentId, replyCount),
    );
  });
  // 差分ではなく、その絵文字の、いまの状態が届く(冪等)
  for (const event of ['reaction:added', 'reaction:removed'] as const) {
    socket.on(event, (payload) => {
      queryClient.setQueryData<MessagesData>(messagesKey(payload.channelId), (data) =>
        applyReaction(data, payload),
      );
      queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
        applyReactionToReplies(data, payload),
      );
    });
  }
  socket.on('workspace:added', () => {
    void queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
  });
  socket.on('member:joined', ({ workspaceId }) => {
    void queryClient.invalidateQueries({ queryKey: membersKey(workspaceId) });
  });
  // DM の作成(自分が作った別のタブにも、相手にも届く)。一覧を取り直すと、サイドバーに出る
  socket.on('dm:created', (channel) => {
    void queryClient.invalidateQueries({ queryKey: channelsKey(channel.workspaceId) });
  });
  socket.on('channel:created', (channel) => {
    void queryClient.invalidateQueries({ queryKey: channelsKey(channel.workspaceId) });
  });
  socket.on('channel:added', (channel) => {
    void queryClient.invalidateQueries({ queryKey: channelsKey(channel.workspaceId) });
    void queryClient.invalidateQueries({ queryKey: channelMembersKey(channel.id) });
  });
  socket.on('channel:member-joined', ({ channelId }) => {
    void queryClient.invalidateQueries({ queryKey: channelMembersKey(channelId) });
  });
  socket.on('channel:left', () => {
    // ペイロードに、ワークスペースの ID がないため、すべてのチャンネル一覧を取り直す
    void queryClient.invalidateQueries({ queryKey: ['channels'] });
  });
  socket.on('channel:member-left', ({ channelId }) => {
    void queryClient.invalidateQueries({ queryKey: channelMembersKey(channelId) });
  });
  socket.on('user:updated', (user) => {
    queryClient.setQueriesData<MessagesData>({ queryKey: ['messages'] }, (data) =>
      updateAuthor(data, user),
    );
    queryClient.setQueriesData<RepliesData>({ queryKey: ['replies'] }, (data) =>
      updateReplyAuthor(data, user),
    );
    void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    void queryClient.invalidateQueries({ queryKey: ['channel-members'] });
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  });
}

/**
 * 再接続のあとの取り直し(設計書 §6.5)。WebSocket は、切断中のイベントを保証しないため、REST で取り直して置き換える。
 * (1) ワークスペース・チャンネルの一覧(2) 表示中のチャンネルの最新の 50 件(古いページは捨てる)
 */
export function resyncAfterReconnect(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  void queryClient.invalidateQueries({ queryKey: ['channels'] });
  void queryClient.invalidateQueries({ queryKey: ['channel-members'] });
  queryClient.setQueriesData<MessagesData>({ queryKey: ['messages'] }, keepFirstPage);
  void queryClient.invalidateQueries({ queryKey: ['messages'] });
  // 開いているスレッドのパネルは、返信を先頭から取り直す(設計書 §6.5)
  void queryClient.invalidateQueries({ queryKey: ['replies'] });
}

/**
 * ログイン中の間、WebSocket をつなぐ(ログイン済みの画面の中で使う)。
 * - 同じオリジンの /socket.io へ、websocket だけでつなぐ(Cookie が送られる)
 * - 自動の再接続の間隔は、指数的に伸ばし、最大 30 秒(設計書 §6.5)
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    const socket: Socket<ServerToClientEvents> = io({
      transports: ['websocket'],
      reconnectionDelayMax: 30_000,
    });
    let hasConnected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    applyServerEvents(socket, queryClient);

    socket.on('connect', () => {
      setStatus('connected');
      // 2 回目以降の接続(再接続)では、切断中の変化を、REST で取り直す
      if (hasConnected) resyncAfterReconnect(queryClient);
      hasConnected = true;
    });

    socket.on('disconnect', (reason) => {
      setStatus('disconnected');
      // サーバーが切った場合(ログアウト・上限の超過など)は、自動では再接続されない。
      // セッションが無効なら、ログイン画面へ移し、有効なら、少し待ってつなぎ直す
      if (reason === 'io server disconnect') {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
        timer = setTimeout(() => socket.connect(), RECONNECT_AFTER_SERVER_DISCONNECT_MS);
      }
    });

    socket.on('connect_error', (error) => {
      setStatus('disconnected');
      // セッションが無効になっていたら、ログインの状態を確かめ直す(ログイン画面へ移る)
      if (error.message === 'unauthorized') {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    });

    return () => {
      if (timer) clearTimeout(timer);
      socket.disconnect();
    };
  }, [queryClient]);

  return <ConnectionContext.Provider value={status}>{children}</ConnectionContext.Provider>;
}
