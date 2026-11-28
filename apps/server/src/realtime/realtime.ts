import type { ClientToServerEvents, ServerToClientEvents } from '@raisechat/shared';
import { parseCookie } from 'cookie';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { findSessionUser } from '../auth/sessions';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { channelMembers, channels, memberships, sessions } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';

/** ルームの名前(設計書 §6.2)。クライアントが、ルームを指定して参加する手段は、設けない */
export const userRoom = (userId: string) => `user:${userId}`;
export const sessionRoom = (tokenHash: string) => `session:${tokenHash}`;
export const wsRoom = (workspaceId: string) => `ws:${workspaceId}`;
export const chRoom = (channelId: string) => `ch:${channelId}`;

/** ソケットに持たせる情報(設計書 §6.1) */
export interface SocketData {
  userId: string;
  tokenHash: string;
  connectedAt: number;
}

type Io = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface RealtimeOptions {
  db: Db;
  config: Config;
  logger: FastifyBaseLogger;
  /** 1 ユーザーあたりの同時接続の上限。超えたら、最も古い接続を切る(設計書 §6.1) */
  maxConnectionsPerUser?: number;
  /** ソケットのセッションを DB で確認する間隔(ミリ秒)。既定は 1 時間(設計書 §6.3)。テストで短くする */
  sessionCheckIntervalMs?: number;
}

const DEFAULT_MAX_CONNECTIONS_PER_USER = 10;
const DEFAULT_SESSION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** ルーム名のうち、DB の所属から決まるもの(ws: と ch:)。user: と session: は、接続時に決まり、変わらない */
const isMembershipRoom = (room: string) => room.startsWith('ws:') || room.startsWith('ch:');

/**
 * WebSocket(Socket.IO)の基盤(設計書 §6)。サーバーからクライアントへの通知専用で、
 * クライアントからのイベントは、受け付けない(書き込みは、すべて REST で行い、認可を REST に一本化する)。
 */
export class Realtime {
  readonly io: Io;
  private readonly db: Db;
  private readonly logger: FastifyBaseLogger;
  private readonly maxConnectionsPerUser: number;
  private readonly timer: NodeJS.Timeout;

  constructor(httpServer: HttpServer, options: RealtimeOptions) {
    const { db, config, logger } = options;
    this.db = db;
    this.logger = logger;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER;

    this.io = new Server(httpServer, {
      // トランスポートは websocket のみ(Origin の検証を、一か所で済ませるため。設計書 §6.1)
      transports: ['websocket'],
      allowUpgrades: false,
      // クライアントからは何も送らないので、受け付ける大きさを小さくする
      maxHttpBufferSize: 1024,
      // CORS は許可しない(同じオリジンからだけ使う)
      cors: undefined,
      // ハンドシェイクの Origin を検証する。許可するオリジンと一致しない場合と、ヘッダがない場合は、拒否(REST と同じ基準)
      allowRequest: (request, callback) => {
        const origin = request.headers.origin;
        const allowed = origin !== undefined && config.allowedOrigins.includes(origin);
        callback(allowed ? null : 'forbidden_origin', allowed);
      },
    });

    // 認証とルームへの参加は、クライアントに接続の完了を知らせる前に済ませる
    // (クライアントが connect を受けた時点で、通知を受け取れる状態にするため)
    this.io.use((socket, next) => {
      this.authenticate(socket)
        .then(() => next())
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'unauthorized') return next(error);
          this.logger.error({ err: error }, 'WebSocket の接続の処理に失敗');
          next(new Error('internal_error'));
        });
    });

    // 同時接続の上限は、接続が完了してから判定する(接続の途中のソケットは、一覧に含まれないため)
    this.io.on('connection', (socket) => {
      this.enforceConnectionLimit(socket.data.userId).catch((error: unknown) =>
        this.logger.error({ err: error }, '同時接続の上限の処理に失敗'),
      );
    });

    this.timer = setInterval(() => {
      this.checkSessions().catch((error: unknown) =>
        this.logger.error({ err: error }, 'ソケットのセッションの確認に失敗'),
      );
    }, options.sessionCheckIntervalMs ?? DEFAULT_SESSION_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  /** ハンドシェイクの Cookie からセッションを引く。有効でなければ拒否(401 相当) */
  private async authenticate(socket: IoSocket): Promise<void> {
    const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
    const token = cookies[SESSION_COOKIE_NAME];
    const found = token ? await findSessionUser(this.db, token) : null;
    if (!found) throw new Error('unauthorized');

    socket.data.userId = found.user.id;
    socket.data.tokenHash = found.tokenHash;
    socket.data.connectedAt = Date.now();
    void socket.join([userRoom(found.user.id), sessionRoom(found.tokenHash)]);

    // DB の所属から、参加するルームを決めて、参加させる。その後、もう一度 DB を引いて、差分があれば補正する
    await this.reconcile(socket);
    await this.reconcile(socket);
  }

  /** あるユーザーが、いま入るべきルーム(所属が active のワークスペースと、そこで参加しているチャンネル) */
  private async desiredMembershipRooms(userId: string): Promise<Set<string>> {
    const wsRows = await this.db
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));
    const chRows = await this.db
      .select({ channelId: channelMembers.channelId })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      // チャンネルのワークスペースに、active で所属しているものだけ
      .innerJoin(
        memberships,
        and(
          eq(memberships.workspaceId, channels.workspaceId),
          eq(memberships.userId, channelMembers.userId),
          eq(memberships.status, 'active'),
        ),
      )
      .where(eq(channelMembers.userId, userId));
    return new Set([
      ...wsRows.map((r) => wsRoom(r.workspaceId)),
      ...chRows.map((r) => chRoom(r.channelId)),
    ]);
  }

  /** ソケットのルームを、DB の状態に合わせる(足りないものに参加させ、余分なものから外す) */
  private async reconcile(socket: IoSocket): Promise<void> {
    const desired = await this.desiredMembershipRooms(socket.data.userId);
    const current = [...socket.rooms].filter(isMembershipRoom);
    const toJoin = [...desired].filter((room) => !socket.rooms.has(room));
    const toLeave = current.filter((room) => !desired.has(room));
    if (toJoin.length > 0) void socket.join(toJoin);
    for (const room of toLeave) void socket.leave(room);
  }

  /** 同時接続が上限を超えたら、最も古い接続から切る */
  private async enforceConnectionLimit(userId: string): Promise<void> {
    const sockets = await this.io.in(userRoom(userId)).fetchSockets();
    const excess = sockets.length - this.maxConnectionsPerUser;
    if (excess <= 0) return;
    sockets
      .sort((a, b) => a.data.connectedAt - b.data.connectedAt)
      .slice(0, excess)
      .forEach((s) => s.disconnect(true));
  }

  /** ソケットのセッションが、まだ有効かを DB で確認し、無効なら切断する(期限切れの接続を残さない) */
  async checkSessions(now: Date = new Date()): Promise<void> {
    const sockets = await this.io.fetchSockets();
    const hashes = [...new Set(sockets.map((s) => s.data.tokenHash))];
    if (hashes.length === 0) return;
    const valid = await this.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(and(inArray(sessions.tokenHash, hashes), gt(sessions.expiresAt, now)));
    const validSet = new Set(valid.map((r) => r.tokenHash));
    for (const hash of hashes) {
      if (!validSet.has(hash)) this.io.in(sessionRoom(hash)).disconnectSockets(true);
    }
  }

  /**
   * ルームの更新や通知に失敗したときは、エラーをログに出し、対象のユーザーのソケットを切断する
   * (再接続のときに、DB から、ルームに参加し直して、補正される。設計書 §6.3)。
   */
  private guard(userIds: string[], action: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.error({ err: error, action }, 'ルームの更新または通知に失敗');
      for (const userId of userIds) this.disconnectUser(userId);
    }
  }

  /** そのユーザーの全ソケットを、ルームに参加させる */
  joinUser(userId: string, rooms: string[]): void {
    this.guard([userId], 'join', () => void this.io.in(userRoom(userId)).socketsJoin(rooms));
  }

  /** そのユーザーの全ソケットを、ルームから外す */
  leaveUser(userId: string, rooms: string[]): void {
    this.guard([userId], 'leave', () => void this.io.in(userRoom(userId)).socketsLeave(rooms));
  }

  /** ルームへ、イベントを送る */
  emit<E extends keyof ServerToClientEvents>(
    rooms: string | string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    try {
      this.io.to(rooms).emit(event, ...args);
    } catch (error) {
      this.logger.error({ err: error, event }, 'イベントの送信に失敗');
    }
  }

  /** そのセッションのソケットだけを切断する(ログアウト。FR-003) */
  disconnectSession(tokenHash: string): void {
    this.io.in(sessionRoom(tokenHash)).disconnectSockets(true);
  }

  /** そのユーザーの全ソケットを切断する */
  disconnectUser(userId: string): void {
    this.io.in(userRoom(userId)).disconnectSockets(true);
  }

  /** そのユーザーの全ソケットのルームを、DB の状態に合わせ直す */
  async resyncUser(userId: string): Promise<void> {
    const remote = await this.io.in(userRoom(userId)).fetchSockets();
    for (const r of remote) {
      const socket = this.io.sockets.sockets.get(r.id);
      if (socket) await this.reconcile(socket);
    }
  }

  /** 終了の処理: タイマーを止め、全接続を閉じる(HTTP サーバーは、呼び出し側が閉じる) */
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.io.disconnectSockets(true);
    await this.io.close();
  }
}
