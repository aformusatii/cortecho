import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { EchoMedia, EchoRun, EchoState, OpenAiCall } from './echo.ts';
import { ECHO_URL, GATEWAY_URL, MEDIA_DIR, OPENAI_MODE, OUT } from './env.ts';
import type { StepFact } from './steps.ts';

export type ReconnectFact = { kind: string; ms: number };

export type RunFacts = {
  image: string;
  commit: string;
  openaiMode: string;
  number: string;
  totalSteps: number;
  startedAt: string;
};

export type EchoFacts = Partial<EchoState> & {
  runs?: EchoRun[];
  media?: Array<EchoMedia & { file?: string }>;
  reconnects?: ReconnectFact[];
};

export type Facts = {
  run: RunFacts;
  steps: StepFact[];
  echo: EchoFacts;
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function dedupe<T>(
  existing: T[] | undefined,
  next: T[] | undefined,
  key: (value: T) => string | number,
): T[] {
  const byKey = new Map<string | number, T>();
  for (const value of [...(existing ?? []), ...(next ?? [])]) byKey.set(key(value), value);
  return [...byKey.values()];
}

function runFacts(): RunFacts {
  return {
    image: process.env.ONBOARDING_IMAGE ?? 'cortecho:onboarding',
    commit: process.env.ONBOARDING_COMMIT ?? 'unknown',
    openaiMode: OPENAI_MODE,
    number: process.env.ONBOARDING_RUN_NUMBER ?? 'local',
    totalSteps: Number(process.env.ONBOARDING_TOTAL_STEPS ?? '12'),
    startedAt: process.env.ONBOARDING_STARTED_AT ?? new Date().toISOString(),
  };
}

/**
 * Fetches the Echo's own view and the gateway's call list, saves the media the
 * Echo downloaded, and merges this phase into /out/facts.json. Both spec files
 * run in the same runner container, so the second phase appends to the first.
 */
export async function collectFacts(
  steps: StepFact[],
  extra: { reconnects?: ReconnectFact[] } = {},
): Promise<void> {
  const state = await fetchJson<EchoState>(`${ECHO_URL}/state`).catch(() => null);
  const calls = await fetchJson<OpenAiCall[]>(`${GATEWAY_URL}/calls`).catch(() => []);
  const media = state ? await saveMedia(state.media) : [];
  const previous = readJson<Facts>(path.join(OUT, 'facts.json'));
  const next: Facts = {
    run: runFacts(),
    steps,
    echo: {
      ...(state ?? {}),
      ...(media.length > 0 ? { media } : {}),
      ...(extra.reconnects ? { reconnects: extra.reconnects } : {}),
    },
  };

  const merged: Facts = {
    run: { ...(previous?.run ?? {}), ...next.run },
    steps: dedupe(previous?.steps, next.steps, (step) => step.n).sort((a, b) => a.n - b.n),
    echo: {
      ...(previous?.echo ?? {}),
      ...next.echo,
      runs: dedupe(previous?.echo?.runs, next.echo.runs, (run) => run.id).sort((a, b) => a.id - b.id),
      media: dedupe(previous?.echo?.media, next.echo.media, (item) => item.n).sort((a, b) => a.n - b.n),
      reconnects: [...(previous?.echo?.reconnects ?? []), ...(next.echo.reconnects ?? [])],
    },
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify(merged, null, 2));
  writeFileSync(path.join(OUT, 'openai-calls.json'), JSON.stringify(calls, null, 2));
}

async function saveMedia(media: EchoMedia[]): Promise<Array<EchoMedia & { file?: string }>> {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const saved: Array<EchoMedia & { file?: string }> = [];
  for (const item of media) {
    const extension = item.format === 'mp3' ? 'mp3' : item.format === 'wav' ? 'wav' : null;
    if (extension === null) {
      saved.push(item);
      continue;
    }
    const response = await fetch(`${ECHO_URL}/media/${item.n}`);
    if (!response.ok) {
      saved.push(item);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const name = `${String(item.n).padStart(3, '0')}-${item.kind ?? 'media'}.${extension}`;
    writeFileSync(path.join(MEDIA_DIR, name), bytes);
    saved.push({ ...item, file: `media/${name}` });
  }
  return saved;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}
