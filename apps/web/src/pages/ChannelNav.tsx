import type { ChannelResponse, WorkspaceResponse } from '@raisechat/shared';
import { Link } from 'react-router-dom';
import { channelLabel } from './channel-label';

/** サイドバーのチャンネル一覧と、ワークスペースの操作(チャンネルの作成・検索、メンバー、招待) */
export function ChannelNav({
  workspace,
  channels,
  currentChannelId,
}: {
  workspace: WorkspaceResponse;
  channels: ChannelResponse[];
  currentChannelId: string | undefined;
}) {
  const base = `/w/${workspace.id}`;
  return (
    <nav aria-label="チャンネル">
      <ul>
        {channels.map((c) => (
          <li key={c.id}>
            <Link
              to={`${base}/c/${c.id}`}
              aria-current={c.id === currentChannelId ? 'page' : undefined}
            >
              {channelLabel(c)}
            </Link>
          </li>
        ))}
      </ul>
      <ul>
        <li>
          <Link to={`${base}/channels/new`}>チャンネルを作成</Link>
        </li>
        <li>
          <Link to={`${base}/channels/browse`}>チャンネルを探す</Link>
        </li>
        <li>
          <Link to={`${base}/members`}>メンバー</Link>
        </li>
        {workspace.role === 'owner' && (
          <li>
            <Link to={`${base}/invitations`}>招待リンクの管理</Link>
          </li>
        )}
      </ul>
    </nav>
  );
}
