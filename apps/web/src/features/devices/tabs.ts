/** The Echo page's tabs; the selected one is in `?tab=` so every tab deep-links. */
export const ECHO_TABS = ['overview', 'connection', 'prompt', 'tuning', 'connectors', 'delete'] as const;
export type EchoTab = (typeof ECHO_TABS)[number];

export function isEchoTab(value: unknown): value is EchoTab {
  return typeof value === 'string' && (ECHO_TABS as readonly string[]).includes(value);
}

export const ECHO_TAB_LABELS: Record<EchoTab, string> = {
  overview: 'Overview',
  connection: 'Connection',
  prompt: 'Prompt',
  tuning: 'Tuning',
  connectors: 'Connectors',
  delete: 'Delete',
};
