import type { ChannelResponse } from '@raisechat/shared';

/** チャンネルの表示名(プライベートは、鍵つき) */
export function channelLabel(channel: Pick<ChannelResponse, 'name' | 'type'>): string {
  return `${channel.type === 'private' ? '🔒' : '#'} ${channel.name ?? ''}`;
}
