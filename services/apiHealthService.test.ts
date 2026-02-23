import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProxyHealth, clearProxyHealthCache } from './apiHealthService';

const mockResponse = (status: number, body: string, contentType = 'application/json') => {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => contentType },
    text: async () => body
  } as unknown as Response;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProxyHealthCache();
  vi.useRealTimers();
});

describe('checkProxyHealth', () => {
  it('returns ok when proxy responds with key', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse(200, JSON.stringify({ ok: true, hasEodhdKey: true })));
    const health = await checkProxyHealth({ force: true });
    expect(health.ok).toBe(true);
    expect(health.hasEodhdKey).toBe(true);
    expect(health.mode).toBe('vercel-proxy');
  });

  it('captures html/404 diagnostics', async () => {
    globalThis.fetch = vi.fn(async () => mockResponse(404, '<html>Not Found</html>', 'text/html'));
    const health = await checkProxyHealth({ force: true });
    expect(health.ok).toBe(false);
    expect(health.diag?.rawPreview).toContain('<html>');
    expect(health.message).toMatch(/proxy/i);
  });

  it('returns timeout message on abort', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url: string, options?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as any).name = 'AbortError';
            reject(err);
          });
        }
      });
    }) as typeof fetch;
    const promise = checkProxyHealth({ force: true, timeoutMs: 10 });
    vi.advanceTimersByTime(20);
    const health = await promise;
    expect(health.ok).toBe(false);
    expect(health.message).toMatch(/timeout/i);
  });
});
