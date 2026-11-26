import type { MeResponse } from '@raisechat/shared';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/** 登録の直後で、リカバリーコードの保存を、まだ確認していない状態 */
export interface PendingRecovery {
  user: MeResponse;
  recoveryCode: string;
}

interface PendingRecoveryValue {
  pending: PendingRecovery | null;
  setPending: (value: PendingRecovery | null) => void;
}

const PendingRecoveryContext = createContext<PendingRecoveryValue | null>(null);

/**
 * 登録の応答は、リカバリーコードを一度しか返さない。
 * 保存の確認が済むまで、コードを、この状態に保持する。
 * 登録した時点で Cookie は付くため、画面の再取得で「ログイン済み」と分かっても、
 * 確認が済むまでは、コードの画面から動かさない(guards.tsx の PublicOnly が、この状態を見る)。
 */
export function PendingRecoveryProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingRecovery | null>(null);
  const value = useMemo(() => ({ pending, setPending }), [pending]);
  return (
    <PendingRecoveryContext.Provider value={value}>{children}</PendingRecoveryContext.Provider>
  );
}

export function usePendingRecovery(): PendingRecoveryValue {
  const value = useContext(PendingRecoveryContext);
  if (!value) throw new Error('PendingRecoveryProvider の中で使ってください');
  return value;
}
