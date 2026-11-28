import type { ChannelResponse } from '@raisechat/shared';

/** チャンネルの表示名(プライベートは、鍵つき) */
export function channelLabel(channel: Pick<ChannelResponse, 'name' | 'type' | 'peer'>): string {
  // DM は、相手の名前(FR-102)
  if (channel.type === 'dm') return `@ ${channel.peer?.displayName ?? ''}`;
  return `${channel.type === 'private' ? '🔒' : '#'} ${channel.name ?? ''}`;
}
