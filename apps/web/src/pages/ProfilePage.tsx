import {
  DISPLAY_NAME_MAX_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  type MeResponse,
} from '@raisechat/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { updateProfile, uploadAvatar } from '../api/auth';
import { errorMessage } from '../api/client';
import { ME_QUERY_KEY, useMe } from '../api/me';

/** アバターの上限(サーバーの AVATAR_MAX_BYTES と同じ。超えるファイルは、送る前に断る。最終的な判定はサーバー) */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

function AvatarSection({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [tooLarge, setTooLarge] = useState(false);

  const mutation = useMutation({
    mutationFn: uploadAvatar,
    onSuccess: (updated) => queryClient.setQueryData(ME_QUERY_KEY, updated),
  });

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = ''; // 同じファイルを、続けて選び直せるように
    if (!file) return;
    setTooLarge(file.size > AVATAR_MAX_BYTES);
    if (file.size > AVATAR_MAX_BYTES) return;
    mutation.mutate(file);
  }

  return (
    <section>
      <h2>アイコン</h2>
      {me.avatarUrl ? (
        <img src={me.avatarUrl} alt="現在のアイコン" width={96} height={96} />
      ) : (
        <p>未設定</p>
      )}
      <label>
        画像を選ぶ(JPEG・PNG・GIF・WebP、2MB まで)
        <input
          type="file"
          name="avatar"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={onChange}
          disabled={mutation.isPending}
        />
      </label>
      {tooLarge && <p role="alert">画像は 2MB 以下にしてください。</p>}
      {mutation.isError && <p role="alert">{errorMessage(mutation.error)}</p>}
    </section>
  );
}

function ProfileForm({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [statusText, setStatusText] = useState(me.statusText);

  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: (updated) => queryClient.setQueryData(ME_QUERY_KEY, updated),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ displayName, statusText });
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        表示名
        <input
          name="displayName"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <p>{DISPLAY_NAME_MAX_LENGTH} 文字まで</p>
      <label>
        ステータス
        <input
          name="statusText"
          value={statusText}
          onChange={(e) => setStatusText(e.target.value)}
        />
      </label>
      <p>{STATUS_TEXT_MAX_LENGTH} 文字まで</p>
      {mutation.isError && <p role="alert">{errorMessage(mutation.error)}</p>}
      {mutation.isSuccess && <p role="status">保存しました。</p>}
      <button type="submit" disabled={mutation.isPending}>
        保存
      </button>
    </form>
  );
}

export function ProfilePage() {
  const { data: me } = useMe();
  if (!me) return null; // RequireAuth の内側なので、通常は到達しない
  return (
    <main>
      <h1>プロフィール</h1>
      <p>ユーザー名: {me.username}</p>
      <ProfileForm me={me} />
      <AvatarSection me={me} />
    </main>
  );
}
