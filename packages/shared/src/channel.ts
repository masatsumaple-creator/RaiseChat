import { z } from 'zod';
import { codePointLength } from './text';

/** チャンネル名の上限(設計書 §2。DB の CHECK と同じ。コードポイント数) */
export const CHANNEL_NAME_MAX_LENGTH = 80;

/** 改行やタブなどの制御文字を含まない(1 行の表示のため) */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

/** 作成できる種類(DM は、別の API で作る) */
export const CREATABLE_CHANNEL_TYPES = ['public', 'private'] as const;

/** POST /workspaces/:ws/channels の本文(FR-202)。余分な項目は拒否する */
export const createChannelSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .refine((v) => codePointLength(v) >= 1, { message: 'チャンネル名を入力してください' })
    .refine((v) => codePointLength(v) <= CHANNEL_NAME_MAX_LENGTH, {
      message: `チャンネル名は ${CHANNEL_NAME_MAX_LENGTH} 文字以下にしてください`,
    })
    .refine((v) => NO_CONTROL_CHARS.test(v), { message: 'チャンネル名に、制御文字は使えません' }),
  type: z.enum(CREATABLE_CHANNEL_TYPES),
});
export type CreateChannelRequest = z.infer<typeof createChannelSchema>;

/** POST /channels/:ch/members の本文(FR-204)。招待する相手のユーザー ID */
export const addChannelMemberSchema = z.strictObject({ userId: z.uuid() });
export type AddChannelMemberRequest = z.infer<typeof addChannelMemberSchema>;

/** POST /workspaces/:ws/dms の本文(FR-102)。相手のユーザー ID */
export const createDmSchema = z.strictObject({ userId: z.uuid() });
export type CreateDmRequest = z.infer<typeof createDmSchema>;

export type ChannelType = 'public' | 'private' | 'dm';

/** DM の相手(DM のチャンネルの応答に含める) */
export interface DmPeer {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ChannelResponse {
  id: string;
  workspaceId: string;
  type: ChannelType;
  /** DM は null */
  name: string | null;
  /** 既定チャンネル(general)。退出・削除できない */
  isDefault: boolean;
  createdBy: string | null;
  /** DM なら、呼び出した人から見た相手。DM 以外は null */
  peer: DmPeer | null;
}

/** オーナーの管理一覧(GET /workspaces/:ws/channels/admin)。内容は見せず、名前だけ */
export interface AdminChannelResponse {
  id: string;
  type: 'public' | 'private';
  name: string;
  isDefault: boolean;
}

/** チャンネルの参加者(GET /channels/:ch/members) */
export interface ChannelMemberResponse {
  id: string;
  username: string;
  displayName: string;
  statusText: string;
  avatarUrl: string | null;
}
