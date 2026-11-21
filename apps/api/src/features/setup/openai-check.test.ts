import { describe, expect, it, vi } from 'vitest';
import { checkOpenAiKey } from './openai-check.ts';

const KEY = 'sk-test-not-a-real-key';

function fetchReturning(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe('checkOpenAiKey', () => {
  it('lists the models with the key against the configured base URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const result = await checkOpenAiKey({
      apiKey: KEY,
      baseUrl: 'http://openai.test/v1/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://openai.test/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('uses OpenAI itself when no base URL is configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await checkOpenAiKey({
      apiKey: KEY,
      baseUrl: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://api.openai.com/v1/models');
  });

  it('reports a refused key separately from an unreachable server', async () => {
    await expect(
      checkOpenAiKey({ apiKey: KEY, baseUrl: undefined, fetchImpl: fetchReturning(401) }),
    ).resolves.toEqual({ ok: false, code: 'rejected' });
    await expect(
      checkOpenAiKey({ apiKey: KEY, baseUrl: undefined, fetchImpl: fetchReturning(403) }),
    ).resolves.toEqual({ ok: false, code: 'rejected' });
    await expect(
      checkOpenAiKey({ apiKey: KEY, baseUrl: undefined, fetchImpl: fetchReturning(500) }),
    ).resolves.toEqual({ ok: false, code: 'unreachable' });
  });

  it('turns a network error or a timeout into unreachable', async () => {
    const failed = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      checkOpenAiKey({ apiKey: KEY, baseUrl: undefined, fetchImpl: failed as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: false, code: 'unreachable' });

    const timedOut = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(
      checkOpenAiKey({
        apiKey: KEY,
        baseUrl: undefined,
        fetchImpl: timedOut as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ ok: false, code: 'unreachable' });
  });

  it('never carries the key in its answer', async () => {
    const result = await checkOpenAiKey({
      apiKey: KEY,
      baseUrl: undefined,
      fetchImpl: fetchReturning(401),
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
