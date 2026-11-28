import type { WorkspaceResponse } from '@raisechat/shared';
import { Link } from 'react-router-dom';

/** ワークスペースの一覧と切り替え(FR-206)。切り替えると、そのワークスペースで参加しているチャンネルだけが見える */
export function WorkspaceSwitcher({
  workspaces,
  currentId,
}: {
  workspaces: WorkspaceResponse[];
  currentId: string | undefined;
}) {
  return (
    <nav aria-label="ワークスペース">
      <ul>
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link to={`/w/${w.id}`} aria-current={w.id === currentId ? 'page' : undefined}>
              {w.name}
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/workspaces/new">ワークスペースを作成</Link>
    </nav>
  );
}
