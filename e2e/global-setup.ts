import { type FullConfig, request } from '@playwright/test';

// Screenshots are committed, so the settings page must show demo content, never
// whatever the machine's owner had. The e2e server imports no prompt file (see
// SYSTEM_PROMPT_FILE in playwright.config.ts); this writes a fictional one.
export const DEMO_HOUSEHOLD_PROMPT =
  'You are the voice assistant of the Example family in Springfield. ' +
  'The household has two children, Ada and Sam, and a cat called Pixel. ' +
  'Keep answers short and friendly.';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('e2e global setup needs a baseURL');
  const context = await request.newContext({ baseURL });
  try {
    const current = await context.get('/api/settings');
    if (!current.ok()) throw new Error(`GET /api/settings failed: ${current.status()}`);
    const { version } = (await current.json()) as { version: number };
    const response = await context.patch('/api/settings', {
      data: { version, changes: { 'assistant.householdPrompt': DEMO_HOUSEHOLD_PROMPT } },
    });
    if (!response.ok()) throw new Error(`PATCH /api/settings failed: ${response.status()}`);
  } finally {
    await context.dispose();
  }
}
