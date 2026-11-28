import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('何も設定しなくても、開発用の既定値で読み込める', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(config.trustedProxies).toEqual([]);
    expect(config.isProduction).toBe(false);
    expect(config.registerRateLimit).toBe(10);
  });

  it('登録の回数の上限は、環境変数で変えられる(E2E 用)。1 未満は、エラー', () => {
    expect(loadConfig({ REGISTER_RATE_LIMIT: '1000' }).registerRateLimit).toBe(1000);
    expect(() => loadConfig({ REGISTER_RATE_LIMIT: '0' })).toThrow();
  });

  it('許可するオリジンは、カンマ区切りで複数指定でき、正規化される', () => {
    const config = loadConfig({
      ALLOWED_ORIGIN: 'https://chat.example.com/, http://localhost:5173/path',
    });
    expect(config.allowedOrigins).toEqual(['https://chat.example.com', 'http://localhost:5173']);
  });

  it('信頼するプロキシは、カンマ区切りで読み込む', () => {
    const config = loadConfig({ TRUSTED_PROXIES: '10.0.0.1, 192.168.0.0/16' });
    expect(config.trustedProxies).toEqual(['10.0.0.1', '192.168.0.0/16']);
  });

  it('NODE_ENV が production のとき、isProduction が true', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('不正な値は、起動時にエラーにする', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('環境変数が不正です');
    expect(() => loadConfig({ PORT: '70000' })).toThrow('環境変数が不正です');
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow('環境変数が不正です');
    expect(() => loadConfig({ ALLOWED_ORIGIN: 'not a url' })).toThrow('ALLOWED_ORIGIN');
    expect(() => loadConfig({ ALLOWED_ORIGIN: 'ftp://example.com' })).toThrow('ALLOWED_ORIGIN');
    expect(() => loadConfig({ ALLOWED_ORIGIN: ' , ' })).toThrow('ALLOWED_ORIGIN');
  });

  it('エラーの文面に、接続文字列などの値を含めない', () => {
    const secret = 'postgres://user:SuperSecret@host/db';
    try {
      loadConfig({ DATABASE_URL: secret, PORT: 'abc' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SuperSecret');
    }
  });
});
