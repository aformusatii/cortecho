import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Turns the Playwright merge, the Echo facts and the gateway's call list into
 * one readable proof. It has no dependencies: the runner image and CI both run
 * it with plain Node. Bodies, audio and transcripts never appear here.
 */

type StepFact = {
  n: number;
  title: string;
  spec: string;
  status: 'passed' | 'failed';
  durationMs: number;
  screenshot: string;
};

type PlayedFact = {
  n: number;
  kind: string;
  url: string;
  format: string;
  sampleRate: number;
  bytes: number;
  at: string;
};

type MediaFact = {
  n: number;
  url: string;
  kind: string | null;
  format: string | null;
  bytes: number;
  file?: string;
};

type RunFact = {
  id: number;
  done: boolean;
  outcome: string;
  runEnd: boolean;
  error: string | null;
  events: Array<{ type: string; ms: number }>;
  played: PlayedFact[];
};

type EchoFacts = {
  keyState?: 'none' | 'set';
  encrypted?: boolean;
  subscribed?: boolean;
  timeAnswers?: { count: number; keyed: boolean; last: { epochSeconds: number } | null };
  played?: PlayedFact[];
  media?: MediaFact[];
  runs?: RunFact[];
  reconnects?: Array<{ kind: string; ms: number }>;
};

type Facts = {
  run?: {
    image?: string;
    commit?: string;
    openaiMode?: string;
    number?: string | number;
    totalSteps?: number;
    startedAt?: string;
  };
  steps?: StepFact[];
  echo?: EchoFacts;
};

type Call = { at: string; method: string; path: string; status: number; ms: number; model?: string };

type TestResult = { status?: string; duration?: number };
type TestCase = { title?: string; results?: TestResult[]; ok?: boolean };
type SpecReport = {
  title?: string;
  file?: string;
  ok?: boolean;
  tags?: string[];
  tests?: TestCase[];
  suites?: SpecReport[];
};
type SuiteReport = { title?: string; file?: string; specs?: SpecReport[]; suites?: SuiteReport[] };
type Results = {
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number; duration?: number };
  suites?: SuiteReport[];
};

const args = process.argv.slice(2);
const outDir = option('--out') ?? fileURLToPath(new URL('../out', import.meta.url));
const assetsBase = option('--assets-base-url')?.replace(/\/+$/, '') ?? '';
const facts = readJson<Facts>(path.join(outDir, 'facts.json')) ?? {};
const results = readJson<Results>(path.join(outDir, 'results.json')) ?? {};
const calls = readJson<Call[]>(path.join(outDir, 'openai-calls.json')) ?? [];
const steps = [...(facts.steps ?? [])].sort((a, b) => a.n - b.n);
const echo = facts.echo ?? {};
const totalSteps = facts.run?.totalSteps ?? 12;
const passed = steps.filter((step) => step.status === 'passed').length;
const failedTests = countFailedTests(results);
const resultsOk = (results.stats?.unexpected ?? failedTests) === 0;
const ok = resultsOk && passed === totalSteps && steps.length === totalSteps;
const runNumber = String(facts.run?.number ?? Date.now());
const totalMs = Math.max(
  results.stats?.duration ?? 0,
  steps.reduce((sum, step) => sum + step.durationMs, 0),
);

const lines: string[] = [];
lines.push(
  `# ${ok ? '✅' : '❌'} Onboarding E2E ${ok ? 'passed' : 'failed'} — ${passed}/${totalSteps} steps`,
);
lines.push('');
lines.push(
  ok
    ? 'A fresh install of the shipped Docker image onboarded a simulated Echo Dot end to end.'
    : 'The run did not complete every step. See the failing steps and the report below.',
);
lines.push('');

lines.push('## Run');
lines.push('');
lines.push('| | |');
lines.push('|---|---|');
lines.push(`| Image | \`${facts.run?.image ?? 'unknown'}\` |`);
lines.push(`| Commit | \`${facts.run?.commit ?? 'unknown'}\` |`);
lines.push(`| OpenAI | ${facts.run?.openaiMode ?? 'unknown'} |`);
lines.push(`| Steps | ${passed}/${totalSteps} passed |`);
lines.push(`| Total time | ${formatDuration(totalMs)} |`);
lines.push(`| Started | ${facts.run?.startedAt ?? 'unknown'} |`);
lines.push('');

const bySpec = new Map<string, StepFact[]>();
for (const step of steps) {
  const list = bySpec.get(step.spec) ?? [];
  list.push(step);
  bySpec.set(step.spec, list);
}
for (const [spec, specSteps] of bySpec) {
  const status = specStatus(results, spec);
  lines.push(`## ${spec} ${status}`);
  lines.push('');
  lines.push('| # | Step | Result | Time | Screenshot |');
  lines.push('|---|------|--------|------|------------|');
  for (const step of specSteps) {
    const link = assetUrl(step.screenshot, runNumber);
    lines.push(
      `| ${step.n} | ${step.title} | ${step.status === 'passed' ? '✅' : '❌'} | ${formatSeconds(step.durationMs)} | [png](${link}) |`,
    );
  }
  lines.push('');
  if (assetsBase) {
    lines.push('<details>');
    lines.push('<summary>Step screenshots</summary>');
    lines.push('');
    for (const step of specSteps) {
      lines.push(
        `![${String(step.n).padStart(2, '0')} · ${step.title}](${assetUrl(step.screenshot, runNumber)})`,
      );
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}

lines.push('## What the Echo saw');
lines.push('');
lines.push(
  `- Adopted with a key: ${yesNo(echo.keyState === 'set')} (key state \`${echo.keyState ?? 'unknown'}\`).`,
);
lines.push(
  `- Encrypted link: ${yesNo(echo.encrypted === true)}; subscribed: ${yesNo(echo.subscribed === true)}.`,
);
const chime = playedOf(echo, 'announcement');
const reply = playedOf(echo, 'reply');
const chimeMedia = mediaFor(echo, chime?.n);
const replyMedia = mediaFor(echo, reply?.n);
if (chime) {
  lines.push(
    `- Chime downloaded from \`${chime.url}\` (${chime.format.toUpperCase()}, ${sizeText(chimeMedia?.bytes ?? chime.bytes)}${mediaLink(chimeMedia?.file)}).`,
  );
} else {
  lines.push('- Chime: not recorded.');
}
if (reply) {
  lines.push(
    `- Reply played from \`${reply.url}\` (${reply.format.toUpperCase()}, ${sizeText(replyMedia?.bytes ?? reply.bytes)}${mediaLink(replyMedia?.file)}).`,
  );
} else {
  lines.push('- Reply: not recorded.');
}
const timeAnswers = echo.timeAnswers;
if (timeAnswers) {
  lines.push(
    `- Time synced: ${timeAnswers.count} answer(s), ${yesNo(timeAnswers.keyed)} over the keyed link, last epoch ${timeAnswers.last?.epochSeconds ?? '–'}.`,
  );
}
const runs = echo.runs ?? [];
if (runs.length > 0) {
  const answered = runs.filter((run) => run.outcome === 'answered').length;
  const runEnd = runs.filter((run) => run.runEnd).length;
  lines.push(`- Voice runs: ${runs.length}, ${answered} answered, ${runEnd} ended with RUN_END.`);
}
const reconnects = echo.reconnects ?? [];
if (reconnects.length > 0) {
  lines.push(
    `- Reconnects: ${reconnects.map((item) => `${item.kind} in ${formatSeconds(item.ms)}`).join(', ')}.`,
  );
}
lines.push('');

lines.push('## OpenAI calls');
lines.push('');
if (calls.length === 0) {
  lines.push('No calls recorded.');
} else {
  lines.push('| Method | Path | Status | Time | Model |');
  lines.push('|--------|------|--------|------|-------|');
  for (const call of calls) {
    lines.push(
      `| ${call.method} | \`${call.path}\` | ${call.status} | ${formatSeconds(call.ms)} | ${call.model ?? '–'} |`,
    );
  }
}
lines.push('');

lines.push('## Report');
lines.push('');
if (assetsBase) {
  lines.push(`[Open the full report (video + trace)](${assetsBase}/)`);
} else {
  lines.push('[Open the full report (video + trace)](report/index.html)');
}
lines.push('');
const artifactDir = assetsBase || '.';
lines.push(`Artifacts: \`${artifactDir}\` (summary, steps, media, logs, openai-calls.json, results.json).`);
lines.push('');

const markdown = `${lines.join('\n')}\n`;
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'summary.md'), markdown);
process.stdout.write(markdown);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function assetUrl(relative: string, run: string): string {
  return assetsBase ? `${assetsBase}/${relative}?run=${run}` : relative;
}

function playedOf(echoFacts: EchoFacts, kind: string): PlayedFact | undefined {
  return (echoFacts.played ?? []).find((item) => item.kind === kind);
}

function mediaFor(echoFacts: EchoFacts, n: number | undefined): MediaFact | undefined {
  if (n === undefined) return undefined;
  return (echoFacts.media ?? []).find((item) => item.n === n);
}

function mediaLink(file: string | undefined): string {
  if (!file) return '';
  return assetsBase ? ` ([file](${assetsBase}/${file}))` : ` ([file](${file}))`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

function specStatus(report: Results, spec: string): string {
  const found = findSpec(report.suites ?? [], spec);
  if (!found) return '';
  return found.ok === false ? '❌' : '✅';
}

function findSpec(suites: SuiteReport[], spec: string): SpecReport | null {
  for (const suite of suites) {
    for (const candidate of suite.specs ?? []) {
      if (path.basename(candidate.file ?? suite.file ?? '') === spec) return candidate;
    }
    const child = findSpec(suite.suites ?? [], spec);
    if (child) return child;
  }
  return null;
}

function countFailedTests(report: Results): number {
  let failed = 0;
  const walk = (suites: SuiteReport[]): void => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const result of spec.tests ?? []) {
          const status = result.results?.[0]?.status;
          if (status && status !== 'passed' && status !== 'skipped') failed += 1;
        }
      }
      walk(suite.suites ?? []);
    }
  };
  walk(report.suites ?? []);
  return failed;
}
