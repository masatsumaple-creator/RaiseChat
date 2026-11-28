import { z } from 'zod';
import type { WorkspaceResponse } from './workspace';

/** POST /workspaces/:ws/invitations の本文。省略した項目は、既定値になる。余分な項目は拒否する */
export const createInvitationSchema = z.strictObject({
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
  maxUses: z.union([z.literal(1), z.literal(10), z.literal('unlimited')]).default(10),
});
export type CreateInvitationRequest = z.input<typeof createInvitationSchema>;

export type InvitationStatus = 'active' | 'expired' | 'revoked' | 'exhausted';

/** 発行済みリンクの一覧の 1 件。トークンは含めない(発行の応答でだけ返す) */
export interface InvitationResponse {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** null は無制限 */
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  status: InvitationStatus;
}

/** 発行の応答。トークンは、この応答でだけ返す(サーバーはハッシュしか持たない) */
export interface InvitationCreatedResponse extends InvitationResponse {
  token: string;
}

/** 受諾前の確認(GET /invitations/:token)。ワークスペース名だけを返す */
export interface InvitationPreviewResponse {
  workspaceName: string;
}

/** 受諾の応答(POST /invitations/:token/accept)。参加したワークスペース */
export type InvitationAcceptResponse = WorkspaceResponse;
