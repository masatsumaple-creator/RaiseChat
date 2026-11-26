import { z } from 'zod';
import { codePointLength } from './text';

/** ワークスペース名の上限(設計書 §2。DB の CHECK と同じ。コードポイント数) */
export const WORKSPACE_NAME_MAX_LENGTH = 50;

/** 改行やタブなどの制御文字を含まない(1 行の表示のため) */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

/** POST /workspaces の本文(FR-201)。余分な項目は拒否する */
export const createWorkspaceSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .refine((v) => codePointLength(v) >= 1, { message: 'ワークスペース名を入力してください' })
    .refine((v) => codePointLength(v) <= WORKSPACE_NAME_MAX_LENGTH, {
      message: `ワークスペース名は ${WORKSPACE_NAME_MAX_LENGTH} 文字以下にしてください`,
    })
    .refine((v) => NO_CONTROL_CHARS.test(v), {
      message: 'ワークスペース名に、制御文字は使えません',
    }),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceSchema>;

export type WorkspaceRole = 'owner' | 'member';

/** ワークスペースの情報(一覧・作成・個別の取得で共通) */
export interface WorkspaceResponse {
  id: string;
  name: string;
  /** 呼び出し者の役割 */
  role: WorkspaceRole;
}

/** ワークスペースのメンバー(GET /workspaces/:ws/members) */
export interface MemberResponse {
  id: string;
  username: string;
  displayName: string;
  statusText: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
}
