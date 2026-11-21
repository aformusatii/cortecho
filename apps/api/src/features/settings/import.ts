import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, SETTING_DESCRIPTORS, type SettingDescriptor } from '@cortecho/shared';
import { REPO_ROOT } from '../../env.ts';
import { createLogger } from '../../lib/logger.ts';
import { BASE_RULES } from '../../pipeline/prompt-layers.ts';
import { SEARCH_POLICY } from '../../pipeline/search-policy.ts';
import type { SettingsStore } from './settings-store.ts';

const log = createLogger('settings');

export type ImportOptions = {
  env?: NodeJS.ProcessEnv;
  /** The prompt file; null = do not import a prompt. */
  promptFile?: string | null;
};

export type ImportResult = {
  imported: string[];
  /** Blocks of the prompt file that were dropped because a code layer owns them. */
  dropped: string[];
};

/**
 * One-time import of the environment configuration.
 * Runs only while nothing has been saved yet; after that the database wins and
 * the variables are ignored. SystemPrompt.md is split: the built-in answer
 * rules and the search policy belong to layer 2 (code), the rest is the
 * household prompt.
 */
export function importSettingsFromEnvironment(
  store: SettingsStore,
  { env = process.env, promptFile = path.join(REPO_ROOT, 'SystemPrompt.md') }: ImportOptions = {},
): ImportResult | null {
  if (store.version !== 0 || Object.keys(store.storedValues()).length > 0) return null;

  const values: Record<string, unknown> = {};
  for (const descriptor of SETTING_DESCRIPTORS) {
    if (!descriptor.env) continue;
    const value = readEnvValue(descriptor, env[descriptor.env]);
    if (value === undefined) continue;
    if (JSON.stringify(value) === JSON.stringify(descriptor.default)) continue;
    values[descriptor.key] = value;
  }

  let dropped: string[] = [];
  if (promptFile) {
    const content = readPromptFile(promptFile);
    if (content !== null) {
      const split = extractHouseholdPrompt(content);
      dropped = split.dropped;
      if (split.text && split.text !== DEFAULT_SETTINGS['assistant.householdPrompt']) {
        values['assistant.householdPrompt'] = split.text;
      }
    }
  }

  const snapshot = store.importValues(values);
  if (!snapshot) return null;
  return { imported: Object.keys(values), dropped };
}

/** Warns once at start about variables that a settings key now supersedes. */
export function warnStaleEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const stillSet = SETTING_DESCRIPTORS.filter(
    (descriptor) =>
      descriptor.env &&
      // TZ also stays in the environment for the container clock; it only seeds the setting.
      descriptor.key !== 'assistant.timeZone' &&
      (env[descriptor.env] ?? '').trim() !== '',
  ).map((descriptor) => descriptor.env);
  if (stillSet.length > 0) {
    log.warn(
      `these environment variables are ignored now (they are settings; see /api/settings): ${stillSet.join(', ')}`,
    );
  }
}

/**
 * Drops the paragraphs a code layer owns. The file in use today mixes all
 * three: the default base sentences, the household facts, and SEARCH_POLICY
 * verbatim. Only the household facts are kept.
 */
export function extractHouseholdPrompt(content: string): { text: string; dropped: string[] } {
  // The pre-2026-11-21 clarifying rule stays recognised: old SystemPrompt.md files contain it.
  const baseLines = new Set(
    [...BASE_RULES, 'If a request is unclear, ask one short question back.'].map(normalise),
  );
  const policy = normalise(SEARCH_POLICY);
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const block of content
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (normalise(block) === policy) {
      dropped.push(block);
      continue;
    }
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const remaining = lines.filter((line) => !baseLines.has(normalise(line)));
    if (remaining.length === 0) {
      dropped.push(block);
      continue;
    }
    if (remaining.length !== lines.length) dropped.push(block);
    kept.push(remaining.join(' '));
  }
  return { text: kept.join('\n\n').trim(), dropped };
}

function readPromptFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn(`could not read ${file}: ${(error as Error).message}`);
    return null;
  }
}

function readEnvValue(descriptor: SettingDescriptor, raw: string | undefined): unknown {
  const value = raw?.trim();
  if (!value) return undefined;
  if (descriptor.secret) return value;
  if (descriptor.control === 'switch') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  if (typeof descriptor.default === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(descriptor.default)) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
