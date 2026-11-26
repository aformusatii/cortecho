import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Builds the human-readable proof from the run's own data. It runs inside the
 * runner image after merge-reports and summary.ts: the HTML is one
 * self-contained file, and the PNG/PDF are rendered from the same page without
 * the videos (a contact sheet, not a wall of screenshots).
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
  bytes: number;
};

type EchoFacts = {
  keyState?: 'none' | 'set';
  encrypted?: boolean;
  subscribed?: boolean;
  timeAnswers?: { count: number; keyed: boolean; last: { epochSeconds: number } | null };
  played?: PlayedFact[];
  runs?: Array<{ outcome: string; runEnd: boolean }>;
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

type Call = { method: string; path: string; status: number; ms: number; model?: string };
type Results = {
  stats?: { unexpected?: number; duration?: number };
  suites?: Array<{ specs?: Array<{ tests?: Array<{ results?: Array<{ status?: string }> }> }> }>;
};

const OUT = '/out';
const PROOF = path.join(OUT, 'proof');
const ARTIFACTS = path.join(OUT, 'artifacts');
const STEP_DIR = path.join(OUT, 'steps');
const VIDEO_LIMIT = 20 * 1024 * 1024;

mkdirSync(PROOF, { recursive: true });

const facts = readJson<Facts>(path.join(OUT, 'facts.json')) ?? {};
const results = readJson<Results>(path.join(OUT, 'results.json')) ?? {};
const calls = readJson<Call[]>(path.join(OUT, 'openai-calls.json')) ?? [];
const steps = [...(facts.steps ?? [])].sort((a, b) => a.n - b.n);
const total = facts.run?.totalSteps ?? 12;
const passed = steps.filter((step) => step.status === 'passed').length;
const resultsFailed = (results.stats?.unexpected ?? failedTests(results)) > 0;
const ok = !resultsFailed && passed === total && steps.length === total;
const totalMs = Math.max(
  results.stats?.duration ?? 0,
  steps.reduce((sum, step) => sum + step.durationMs, 0),
);

const videos = collectVideos();
const html = buildHtml(true, videos);
writeFileSync(path.join(PROOF, 'onboarding-proof.html'), html);

const noVideoHtml = buildHtml(false, videos);
await render(noVideoHtml);

function buildHtml(
  withVideos: boolean,
  videoFiles: { setup: string | null; restart: string | null },
): string {
  const headline = `Onboarding E2E ${ok ? 'passed' : 'failed'} — ${passed}/${total} steps`;
  const openAiMode = facts.run?.openaiMode ?? 'unknown';
  const startedAt = facts.run?.startedAt ? new Date(facts.run.startedAt) : new Date();
  const totalBytes = [videoFiles.setup, videoFiles.restart]
    .filter((file): file is string => file !== null)
    .reduce((sum, file) => sum + statSync(file).size, 0);
  const embedVideos = videoFiles.setup !== null && videoFiles.restart !== null && totalBytes < VIDEO_LIMIT;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(headline)}</title>
<style>
  :root { color-scheme: light; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; --card:#fff; --good:#15803d; --bad:#b91c1c; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .page { max-width:1240px; margin:0 auto; padding:32px 28px 56px; }
  h1 { margin:0 0 6px; font-size:34px; line-height:1.15; letter-spacing:-0.02em; color:${ok ? 'var(--good)' : 'var(--bad)'}; }
  h2 { margin:34px 0 12px; font-size:20px; letter-spacing:-0.01em; }
  .sub { margin:0; color:var(--muted); }
  .facts { margin-top:22px; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; }
  .fact { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .fact b { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
  .fact span { display:block; margin-top:2px; font-size:13px; overflow-wrap:anywhere; }
  .steps { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; break-inside:avoid; box-shadow:0 1px 2px rgb(15 23 42 / .04); }
  .card h3 { margin:0 0 8px; font-size:15px; display:flex; gap:8px; align-items:baseline; }
  .card h3 small { color:var(--muted); font-weight:500; font-size:12px; }
  .shot { display:block; width:100%; height:auto; border:1px solid var(--line); border-radius:8px; background:#f1f5f9; }
  .empty { padding:40px 12px; text-align:center; color:var(--muted); border:1px dashed var(--line); border-radius:8px; }
  ul { margin:8px 0 0; padding-left:20px; }
  li { margin:4px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { background:#f1f5f9; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  tr:last-child td { border-bottom:0; }
  code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
  .videos { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
  .video { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
  .video h3 { margin:0 0 8px; font-size:15px; }
  video { width:100%; border-radius:8px; background:#000; }
  .note { color:var(--muted); background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  @media print {
    body { background:#fff; font-size:12px; }
    .page { max-width:none; padding:0; }
    h1 { font-size:24px; }
    h2 { margin-top:18px; }
    .facts { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .steps { grid-template-columns:1fr; gap:12px; }
    .card { break-after:page; }
    .card:last-child { break-after:auto; }
    .videos, .no-print { display:none; }
    table { font-size:11px; }
  }
</style>
</head>
<body>
<div class="page">
  <h1>${ok ? '✅' : '❌'} ${escapeHtml(headline)}</h1>
  <p class="sub">A fresh install of the shipped Docker image onboarded a simulated Echo Dot end to end.</p>

  <div class="facts">
    ${fact('Image', facts.run?.image ?? 'unknown')}
    ${fact('Commit', facts.run?.commit ?? 'unknown')}
    ${fact('OpenAI', openAiMode)}
    ${fact('Date', startedAt.toISOString())}
    ${fact('Total time', formatDuration(totalMs))}
  </div>

  <h2>Steps</h2>
  <div class="steps">
    ${steps.map((step) => stepCard(step)).join('\n')}
  </div>

  <h2>What the Echo saw</h2>
  <ul>
    ${echoBullets()}
  </ul>

  <h2>OpenAI calls</h2>
  ${callsTable(calls)}

  ${
    withVideos
      ? `<h2>Videos</h2>
  ${
    embedVideos
      ? `<div class="videos">
    <div class="video"><h3>Onboarding</h3><video controls preload="metadata" src="data:video/webm;base64,${base64(videoFiles.setup as string)}"></video></div>
    <div class="video"><h3>After the restart</h3><video controls preload="metadata" src="data:video/webm;base64,${base64(videoFiles.restart as string)}"></video></div>
  </div>`
      : `<p class="note">The videos are attached separately: <code>onboarding-1-setup.webm</code> and <code>onboarding-2-after-restart.webm</code> (together they exceed 20 MB, so they are not embedded here).</p>`
  }`
      : ''
  }
</div>
</body>
</html>`;
}

function stepCard(step: StepFact): string {
  const shot = path.join(STEP_DIR, path.basename(step.screenshot));
  const image = existsSync(shot)
    ? `<img class="shot" src="data:image/png;base64,${base64(shot)}" alt="${escapeHtml(`${step.n} ${step.title}`)}">`
    : '<div class="empty">Screenshot missing</div>';
  return `<article class="card">
    <h3>${step.status === 'passed' ? '✅' : '❌'} ${String(step.n).padStart(2, '0')} · ${escapeHtml(step.title)} <small>${formatSeconds(step.durationMs)}</small></h3>
    ${image}
  </article>`;
}

function fact(label: string, value: string): string {
  return `<div class="fact"><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></div>`;
}

function echoBullets(): string {
  const echo = facts.echo ?? {};
  const played = echo.played ?? [];
  const chime = played.find((item) => item.kind === 'announcement');
  const reply = played.find((item) => item.kind === 'reply');
  const timeAnswers = echo.timeAnswers;
  const runs = echo.runs ?? [];
  const reconnects = echo.reconnects ?? [];
  const bullets = [
    `Adopted with a key: <b>${echo.keyState === 'set' ? 'yes' : 'no'}</b> (key state <code>${echo.keyState ?? 'unknown'}</code>).`,
    `Encrypted link: <b>${echo.encrypted === true ? 'yes' : 'no'}</b>; subscribed: <b>${echo.subscribed === true ? 'yes' : 'no'}</b>.`,
    chime
      ? `Chime downloaded from <code>${escapeHtml(chime.url)}</code> (${escapeHtml(chime.format.toUpperCase())}, ${sizeText(chime.bytes)}).`
      : 'Chime: not recorded.',
    reply
      ? `Reply played from <code>${escapeHtml(reply.url)}</code> (${escapeHtml(reply.format.toUpperCase())}, ${sizeText(reply.bytes)}).`
      : 'Reply: not recorded.',
    timeAnswers
      ? `Time synced: ${timeAnswers.count} answer(s), <b>${timeAnswers.keyed ? 'yes' : 'no'}</b> over the keyed link, last epoch ${timeAnswers.last?.epochSeconds ?? '–'}.`
      : 'Time sync: not recorded.',
    runs.length > 0
      ? `Voice runs: ${runs.length}, <b>${runs.filter((run) => run.outcome === 'answered').length}</b> answered, <b>${runs.filter((run) => run.runEnd).length}</b> ended with RUN_END.`
      : 'Voice runs: not recorded.',
    reconnects.length > 0
      ? `Reconnects: ${reconnects.map((item) => `${escapeHtml(item.kind)} in ${formatSeconds(item.ms)}`).join(', ')}.`
      : 'Reconnects: none recorded.',
  ];
  return bullets.map((bullet) => `<li>${bullet}</li>`).join('\n    ');
}

function callsTable(items: Call[]): string {
  const filtered = items.filter((call) => call.path.startsWith('/v1/'));
  if (filtered.length === 0) return '<p class="note">No OpenAI calls recorded.</p>';
  return `<table>
    <thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Time</th><th>Model</th></tr></thead>
    <tbody>${filtered
      .map(
        (call) =>
          `<tr><td>${escapeHtml(call.method)}</td><td><code>${escapeHtml(call.path)}</code></td><td>${call.status}</td><td>${formatSeconds(call.ms)}</td><td>${escapeHtml(call.model ?? '–')}</td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

async function render(html: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(PROOF, 'onboarding-proof.png'), fullPage: true });
    await page.pdf({
      path: path.join(PROOF, 'onboarding-proof.pdf'),
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close();
  }
}

/**
 * The two test videos. Playwright writes one per test in /out/artifacts; they
 * finish in run order, so sorting by mtime gives setup then restart. The
 * copies live in /out/proof before run.sh removes the raw artifacts.
 */
function collectVideos(): { setup: string | null; restart: string | null } {
  const setup = path.join(PROOF, 'onboarding-1-setup.webm');
  const restart = path.join(PROOF, 'onboarding-2-after-restart.webm');
  if (existsSync(setup) && existsSync(restart)) return { setup, restart };
  const found = walk(ARTIFACTS)
    .filter((file) => file.endsWith('.webm'))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  if (found[0]) copyFileSync(found[0], setup);
  if (found[1]) copyFileSync(found[1], restart);
  return { setup: existsSync(setup) ? setup : null, restart: existsSync(restart) ? restart : null };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function base64(file: string): string {
  return readFileSync(file).toString('base64');
}

function failedTests(report: Results): number {
  let failed = 0;
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const status = test.results?.[0]?.status;
        if (status && status !== 'passed' && status !== 'skipped') failed += 1;
      }
    }
  }
  return failed;
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

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
