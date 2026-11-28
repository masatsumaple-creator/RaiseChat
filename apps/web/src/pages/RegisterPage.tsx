import { PASSWORD_MIN_LENGTH } from '@raisechat/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { register } from '../api/auth';
import { errorMessage } from '../api/client';
import { ME_QUERY_KEY } from '../api/me';
import { safeNext, withNext } from '../auth/next';
import { usePendingRecovery, type PendingRecovery } from '../auth/pending-recovery';

/** 登録の直後に、リカバリーコードを一度だけ見せる。保存したことの確認が済むまで、先へ進めない */
function RecoveryCodeStep({ pending }: { pending: PendingRecovery }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const next = safeNext(useLocation().search);
  const { setPending } = usePendingRecovery();
  const [saved, setSaved] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pending.recoveryCode);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  function proceed() {
    queryClient.setQueryData(ME_QUERY_KEY, pending.user);
    setPending(null);
    void navigate(next ?? '/', { replace: true });
  }

  return (
    <main>
      <h1>リカバリーコードを保存してください</h1>
      <p>
        パスワードを忘れたときに、このコードで再設定できます。
        <strong>このコードが表示されるのは、今回だけです。</strong>
        安全な場所に保存してください。
      </p>
      <p>
        <code data-testid="recovery-code">{pending.recoveryCode}</code>
      </p>
      <button type="button" onClick={() => void copy()}>
        コピー
      </button>
      {copyFailed && <p role="alert">コピーできませんでした。手で書き写してください。</p>}
      <label>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        リカバリーコードを保存しました
      </label>
      <button type="button" disabled={!saved} onClick={proceed}>
        続ける
      </button>
    </main>
  );
}

export function RegisterPage() {
  const next = safeNext(useLocation().search);
  const { pending, setPending } = usePendingRecovery();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: register,
    // 登録すると Cookie は付くが、コードの確認が済むまでは、ログイン済みの画面へ移さない
    onSuccess: ({ user, recoveryCode }) => setPending({ user, recoveryCode }),
  });

  if (pending) return <RecoveryCodeStep pending={pending} />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ username, password });
  }

  return (
    <main>
      <h1>アカウント登録</h1>
      <form onSubmit={onSubmit}>
        <label>
          ユーザー名
          <input
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          パスワード({PASSWORD_MIN_LENGTH} 文字以上)
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mutation.isError && <p role="alert">{errorMessage(mutation.error)}</p>}
        <button type="submit" disabled={mutation.isPending}>
          登録
        </button>
      </form>
      <p>
        すでにアカウントがある場合は、<Link to={withNext('/login', next)}>ログイン</Link>
      </p>
    </main>
  );
}
