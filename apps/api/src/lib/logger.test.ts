import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, redactText, redactValue, setLogLevel } from './logger.ts';

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('silent');
});

describe('logger redaction', () => {
  it('redacts secret-named keys recursively', () => {
    expect(
      redactValue({
        Authorization: 'Bearer abc',
        access_token: 'at',
        nested: { refresh_token: 'rt', client_secret: 'cs', ok: 'fine' },
        headers: { 'X-Api-Key': 'k' },
      }),
    ).toEqual({
      Authorization: '[redacted]',
      access_token: '[redacted]',
      nested: { refresh_token: '[redacted]', client_secret: '[redacted]', ok: 'fine' },
      headers: { 'X-Api-Key': '[redacted]' },
    });
  });

  it('redacts codes and tokens in free text', () => {
    expect(redactText('callback /api/mcp/oauth/callback?code=abc123&state=xyz&access_token=at-1 end')).toBe(
      'callback /api/mcp/oauth/callback?code=[redacted]&state=[redacted]&access_token=[redacted] end',
    );
  });

  it('never prints a token when a logger is given one', () => {
    setLogLevel('info');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => lines.push(String(line)));
    const log = createLogger('test');
    log.info('signed in', { access_token: 'secret-token', slug: 'gmail' });
    log.warn('callback failed: ?code=oauth-code-123');
    const output = lines.join('\n');
    expect(output).toContain('"slug":"gmail"');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('oauth-code-123');
    expect(output).toContain('[redacted]');
  });
});
