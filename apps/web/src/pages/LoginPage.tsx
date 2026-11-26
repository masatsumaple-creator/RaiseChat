import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { login } from '../api/auth';
import { ME_QUERY_KEY } from '../api/me';
import { errorMessage } from '../api/client';

export function LoginPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: login,
    // ログイン済みになると、PublicOnly が、ホームへ移す
    onSuccess: (me) => queryClient.setQueryData(ME_QUERY_KEY, me),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ username, password });
  }

  return (
    <main>
      <h1>ログイン</h1>
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
          パスワード
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mutation.isError && <p role="alert">{errorMessage(mutation.error)}</p>}
        <button type="submit" disabled={mutation.isPending}>
          ログイン
        </button>
      </form>
      <p>
        アカウントがない場合は、<Link to="/register">新規登録</Link>
      </p>
    </main>
  );
}
