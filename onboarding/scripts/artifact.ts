import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Turns the lab's own reports into the two small machine-readable files the
 * release job reads: `digest.txt` (the image that was tested) and
 * `summary.json` (verdict + counts, "AI: mock"). Plain Node, no deps: CI runs
 * this on the host after onboarding/scripts/run.sh, outside the runner image.
 */

type Results = {
  stats?: {
    expected?: number;
    unexpected?: number;
    skipped?: number;
    flaky?: number;
    duration?: number;
  };
};

type Facts = {
  run?: { totalSteps?: number; openaiMode?: string; elevenlabsMode?: string };
  steps?: Array<{ status?: string }>;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

const out = option('--out') ?? path.resolve(HERE, '../out');
const image = option('--image') ?? 'unknown';
const digest = option('--digest') ?? 'unknown';
const tree = option('--tree') ?? 'unknown';

const results = readJson<Results>(path.join(out, 'results.json')) ?? {};
const facts = readJson<Facts>(path.join(out, 'facts.json')) ?? {};
const steps = facts.steps ?? [];
const totalSteps = facts.run?.totalSteps ?? steps.length;
const passedSteps = steps.filter((step) => step.status === 'passed').length;
const expected = results.stats?.expected ?? 0;
const unexpected = results.stats?.unexpected ?? 0;
const verdict =
  unexpected === 0 && totalSteps > 0 && passedSteps === totalSteps && steps.length === totalSteps
    ? 'passed'
    : 'failed';

const summary = {
  ai: facts.run?.openaiMode === 'mock' ? 'mock' : (facts.run?.openaiMode ?? 'unknown'),
  elevenlabs: facts.run?.elevenlabsMode ?? 'unknown',
  image,
  digest,
  tree,
  verdict,
  steps: { passed: passedSteps, total: totalSteps },
  tests: {
    expected,
    unexpected,
    skipped: results.stats?.skipped ?? 0,
    flaky: results.stats?.flaky ?? 0,
    durationMs: results.stats?.duration ?? 0,
  },
};

writeFileSync(path.join(out, 'digest.txt'), `${digest}\n`);
writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  `evidence: ${verdict} (${passedSteps}/${totalSteps} steps, ${expected} tests passed, ${unexpected} failed); image ${image} @ ${digest}`,
);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
