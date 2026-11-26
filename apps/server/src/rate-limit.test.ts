import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';

function setup(options: { limit?: number; windowMs?: number; maxKeys?: number } = {}) {
  let time = 1_000_000;
  const limiter = new RateLimiter({
    limit: options.limit ?? 3,
    windowMs: options.windowMs ?? 60_000,
    maxKeys: options.maxKeys,
    now: () => time,
  });
  return {
    limiter,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('上限までは通し、超えたら拒否する(consume)', () => {
    const { limiter } = setup({ limit: 3 });
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
  });

  it('キーごとに、別々に数える', () => {
    const { limiter } = setup({ limit: 1 });
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
    expect(limiter.consume('b')).toBe(true);
  });

  it('時間枠が過ぎると、解除される', () => {
    const { limiter, advance } = setup({ limit: 1, windowMs: 60_000 });
    limiter.consume('a');
    expect(limiter.consume('a')).toBe(false);
    advance(59_999);
    expect(limiter.consume('a')).toBe(false);
    advance(1);
    expect(limiter.consume('a')).toBe(true);
  });

  it('reset は、そのキーだけの記憶を消し、数え直しになる', () => {
    const { limiter } = setup({ limit: 1 });
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.isLimited('a')).toBe(true);
    limiter.reset('a');
    expect(limiter.isLimited('a')).toBe(false);
    expect(limiter.consume('a')).toBe(true);
    // 別のキーは、そのまま
    expect(limiter.isLimited('b')).toBe(true);
    // 記憶のないキーを reset しても、何も起きない
    limiter.reset('unknown');
  });

  it('isLimited は、数えない。record だけが数える(失敗だけを数える使い方)', () => {
    const { limiter } = setup({ limit: 2 });
    for (let i = 0; i < 10; i++) expect(limiter.isLimited('a')).toBe(false);
    limiter.record('a');
    expect(limiter.isLimited('a')).toBe(false);
    limiter.record('a');
    expect(limiter.isLimited('a')).toBe(true);
  });

  it('retryAfterSeconds は、解除までの秒数(切り上げ)。制限中でなければ 0', () => {
    const { limiter, advance } = setup({ limit: 1, windowMs: 60_000 });
    expect(limiter.retryAfterSeconds('a')).toBe(0);
    limiter.consume('a');
    expect(limiter.retryAfterSeconds('a')).toBe(60);
    advance(30_500);
    expect(limiter.retryAfterSeconds('a')).toBe(30);
    advance(30_000);
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });

  it('キーの数が上限に達したら、期限切れを掃除する', () => {
    const { limiter, advance } = setup({ limit: 5, windowMs: 1000, maxKeys: 3 });
    limiter.record('a');
    limiter.record('b');
    limiter.record('c');
    advance(1000);
    limiter.record('d');
    expect(limiter.size).toBe(1);
  });

  it('掃除しても空かない場合は、古いキーから捨て、上限を超えない', () => {
    const { limiter } = setup({ limit: 5, windowMs: 60_000, maxKeys: 3 });
    for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.record(key);
    expect(limiter.size).toBeLessThanOrEqual(3);
    // 新しいキーは残り、一番古い a は捨てられている
    expect(limiter.isLimited('a')).toBe(false);
    limiter.record('e');
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});
