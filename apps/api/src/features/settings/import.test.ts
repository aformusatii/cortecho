import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '@cortecho/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { SEARCH_POLICY } from '../../pipeline/search-policy.ts';
import { extractHouseholdPrompt, importSettingsFromEnvironment } from './import.ts';
import { SettingsStore } from './settings-store.ts';

const databases: { close: () => void }[] = [];

function store() {
  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  databases.push({ close: () => sqlite.close() });
  return new SettingsStore(db);
}

function promptFile(contents: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'settings-import-'));
  const file = path.join(dir, 'SystemPrompt.md');
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const HOUSEHOLD = 'You are in a home in Berlin, Germany. The user is Alex.';

describe('importing SystemPrompt.md', () => {
  it('keeps the household facts and drops the code-owned blocks', () => {
    const content = [
      'You are a voice assistant speaking through a small smart speaker in a home.',
      'Your answer is converted to speech, so answer in one to three short sentences.',
      'Never use markdown, lists, emojis, URLs or code. Spell out symbols and units.',
      'The current date and time come with every request; use them for questions about the time, date or day.',
      'Use the tools when they help; never guess device states.',
      'If a request is unclear, ask one short question back.',
      '',
      HOUSEHOLD,
      '',
      SEARCH_POLICY,
    ].join('\n');
    const storage = store();
    const result = importSettingsFromEnvironment(storage, {
      env: {},
      promptFile: promptFile(content),
    });
    expect(result?.imported).toContain('assistant.householdPrompt');
    expect(storage.storedValues()['assistant.householdPrompt']).toBe(HOUSEHOLD);
    expect(result?.dropped).toHaveLength(2);
  });

  it('leaves the default alone when the file is missing or blank', () => {
    for (const contents of [null, '  \n\t\n']) {
      const storage = store();
      const file = contents === null ? '/tmp/opencode/does-not-exist.md' : promptFile(contents);
      const result = importSettingsFromEnvironment(storage, { env: {}, promptFile: file });
      expect(result).toBeNull();
      expect(storage.version).toBe(0);
      expect(storage.current().settings.assistant.householdPrompt).toBe(
        DEFAULT_SETTINGS['assistant.householdPrompt'],
      );
    }
  });

  it('does not throw when the file cannot be read', () => {
    const storage = store();
    expect(() =>
      importSettingsFromEnvironment(storage, { env: {}, promptFile: '/tmp/opencode/nope.md' }),
    ).not.toThrow();
  });

  it('keeps a custom instruction line that is not one of the built-in rules', () => {
    const { text, dropped } = extractHouseholdPrompt(`Be concise and dry.\n\n${HOUSEHOLD}`);
    expect(text).toBe(`Be concise and dry.\n\n${HOUSEHOLD}`);
    expect(dropped).toEqual([]);
  });
});

describe('importing the environment', () => {
  it('reads every descriptor value in its own type and skips the defaults', () => {
    const storage = store();
    importSettingsFromEnvironment(storage, {
      env: {
        TZ: 'UTC',
        AGENT_LOCALE: 'de-DE',
        VAD_END_SILENCE_MS: '650',
        AGENT_WEB_SEARCH_ENABLED: 'false',
        STT_LANGUAGES: 'en, ro',
        APOLOGY_TEXT: 'Try again.',
        TTS_VOICE: 'marin', // the default: not stored
      },
      promptFile: null,
    });
    const { settings } = storage.current();
    expect(settings.assistant.timeZone).toBe('UTC');
    expect(settings.assistant.locale).toBe('de-DE');
    expect(settings.vad.endSilenceMs).toBe(650);
    expect(settings.agent.webSearch).toBe(false);
    expect(settings.stt.languages).toEqual(['en', 'ro']);
    expect(settings.assistant.apologyText).toBe('Try again.');
    expect(storage.storedValues()).not.toHaveProperty('tts.voice');
  });

  it('imports the OpenAI key as a secret that never reaches the history', () => {
    const storage = store();
    importSettingsFromEnvironment(storage, { env: { OPENAI_API_KEY: 'sk-test' }, promptFile: null });
    expect(storage.hasSecret('openai.apiKey')).toBe(true);
    expect(storage.current().settings.openai.apiKey).toBe('sk-test');
    const history = storage.history(10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ key: 'openai.apiKey', oldValue: null, newValue: null });
  });

  it('is a one-time import: a second start changes nothing', () => {
    const storage = store();
    const first = importSettingsFromEnvironment(storage, {
      env: { TZ: 'Europe/Berlin' },
      promptFile: null,
    });
    expect(first).not.toBeNull();
    const version = storage.version;
    const second = importSettingsFromEnvironment(storage, {
      env: { TZ: 'UTC' },
      promptFile: null,
    });
    expect(second).toBeNull();
    expect(storage.version).toBe(version);
    expect(storage.current().settings.assistant.timeZone).toBe('Europe/Berlin');
  });
});
