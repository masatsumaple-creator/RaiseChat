import { codePointLength } from '@raisechat/shared';

// T4 で Fastify の起動に置き換える。T1 では、ワークスペース間の参照が通ることだけを確認する。
export const SERVER_READY = codePointLength('raisechat') > 0;
