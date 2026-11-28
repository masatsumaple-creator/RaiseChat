import { Route, Routes } from 'react-router-dom';
import { PublicOnly, RequireAuth } from './auth/guards';
import { HomePage, NewWorkspacePage } from './pages/HomePage';
import { InvitationsPage } from './pages/InvitationsPage';
import { InvitePage } from './pages/InvitePage';
import { Layout } from './pages/Layout';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { WorkspaceHome } from './pages/WorkspaceHome';
import { WorkspaceShell } from './pages/WorkspaceShell';

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
          <Route path="/workspaces/new" element={<NewWorkspacePage />} />
          <Route path="/w/:wsId" element={<WorkspaceShell />}>
            <Route index element={<WorkspaceHome />} />
            <Route path="invitations" element={<InvitationsPage />} />
          </Route>
        </Route>
      </Route>
      {/* 招待の受諾は、ログインの有無を、画面の中で判断する(未ログインなら、ログイン後に戻る) */}
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
