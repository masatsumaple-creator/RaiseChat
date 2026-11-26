import { Route, Routes } from 'react-router-dom';
import { useMe } from './api/me';
import { PublicOnly, RequireAuth } from './auth/guards';
import { Layout } from './pages/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';

// T9 の時点では、ホームは仮の画面(ワークスペースは、フェーズ 2 で作る)
function HomePage() {
  const { data } = useMe();
  return (
    <main>
      <h1>ようこそ、{data?.displayName}さん</h1>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main>
      <h1>ページが見つかりません</h1>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
