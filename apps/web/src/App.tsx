import { Route, Routes } from 'react-router-dom';
import { useMe } from './api/me';
import { PublicOnly, RequireAuth } from './auth/guards';

// T9 で、実際の画面に置き換える(ここは、画面の振り分けの確認用の仮の画面)
function LoginPage() {
  return <h1>ログイン</h1>;
}

function RegisterPage() {
  return <h1>アカウント登録</h1>;
}

function HomePage() {
  const { data } = useMe();
  return <h1>ようこそ、{data?.displayName}さん</h1>;
}

function NotFoundPage() {
  return <h1>ページが見つかりません</h1>;
}

export function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/" element={<HomePage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
