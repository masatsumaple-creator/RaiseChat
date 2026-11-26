import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';

export interface RateLimiterOptions {
  /** 時間枠の中で、許す回数 */
  limit: number;
  /** 時間枠の長さ(ミリ秒) */
  windowMs: number;
  /** 現在時刻(ミリ秒)。テストで差し替える */
  now?: () => number;
  /** 記憶するキーの上限。超えたら、期限切れを掃除し、それでも超えたら古い順に捨てる */
  maxKeys?: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * メモリ上のレート制限(固定の時間枠)。設計書 §1.1 のとおり、単一プロセス前提で、再起動でリセットされる。
 * - isLimited: 上限に達しているか(数えない)
 * - record: 1 回を数える
 * - consume: 上限に達していなければ数えて true、達していれば false
 * 「失敗だけを数える」場合は、isLimited で確認し、失敗したときだけ record する(設計書 §4.1 の招待リンク)。
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  isLimited(key: string): boolean {
    const entry = this.live(key);
    return entry !== undefined && entry.count >= this.limit;
  }

  record(key: string): void {
    const entry = this.live(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    this.makeRoom();
    this.entries.set(key, { count: 1, resetAt: this.now() + this.windowMs });
  }

  consume(key: string): boolean {
    if (this.isLimited(key)) return false;
    this.record(key);
    return true;
  }

  /** 制限が解除されるまでの秒数(切り上げ)。制限中でなければ 0 */
  retryAfterSeconds(key: string): number {
    const entry = this.live(key);
    if (!entry || entry.count < this.limit) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  /** 記憶しているキーの数(テスト用) */
  get size(): number {
    return this.entries.size;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private makeRoom(): void {
    if (this.entries.size < this.maxKeys) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    // それでも多い場合は、古く入ったものから捨てる(メモリを際限なく使わないため)
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** 上限を超えたときの、429 のエラー(Retry-After つき) */
export function rateLimitedError(retryAfterSeconds: number): AppError {
  return new AppError(429, 'rate_limited', 'しばらくしてから、もう一度お試しください。', {
    'retry-after': String(retryAfterSeconds),
  });
}

/**
 * ルートの preHandler にする。リクエストごとにキーを決め、上限を超えていたら 429。
 * 試行を数える(consume)。失敗だけを数えたい場合は、これを使わず、isLimited と record を自分で呼ぶ。
 */
export function rateLimitGuard(limiter: RateLimiter, keyOf: (request: FastifyRequest) => string) {
  return async (request: FastifyRequest): Promise<void> => {
    const key = keyOf(request);
    if (!limiter.consume(key)) {
      throw rateLimitedError(limiter.retryAfterSeconds(key));
    }
  };
}
