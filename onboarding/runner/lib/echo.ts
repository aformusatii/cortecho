import { ECHO_URL, GATEWAY_URL } from './env.ts';

export type EchoPlayed = {
  n: number;
  kind: string;
  url: string;
  format: string;
  sampleRate: number;
  bytes: number;
  at: string;
};

export type EchoMedia = {
  n: number;
  url: string;
  kind: string | null;
  format: string | null;
  sampleRate: number;
  bytes: number;
  playedBytes: number | null;
  at: string | null;
};

export type EchoEvent = { type: string; ms: number };

export type EchoRun = {
  id: number;
  done: boolean;
  outcome: string;
  runEnd: boolean;
  error: string | null;
  startedAt: string;
  ms: number;
  events: EchoEvent[];
  played: EchoPlayed[];
};

export type EchoState = {
  subscribed: boolean;
  encrypted: boolean;
  keyState: 'none' | 'set';
  connections: number;
  connectionsAccepted?: number;
  setKeyRequests?: number;
  state?: string;
  timeAnswers: {
    count: number;
    keyed: boolean;
    last: { epochSeconds: number; timezone: string; keyed: boolean } | null;
  };
  media: EchoMedia[];
  played: EchoPlayed[];
  events: EchoEvent[];
  runs: EchoRun[];
  lastRun: EchoRun | null;
};

export type OpenAiCall = {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  model?: string;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export function echoJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetchJson<T>(`${ECHO_URL}${path}`, init);
}

export function gatewayJson<T>(path: string): Promise<T> {
  return fetchJson<T>(`${GATEWAY_URL}${path}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `fn` returns a truthy value; used for Echo/API state that settles after an action. */
export async function waitFor<T>(
  fn: () => Promise<T | null | false>,
  {
    timeoutMs = 60_000,
    intervalMs = 250,
    what = 'the condition',
  }: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`);
}
