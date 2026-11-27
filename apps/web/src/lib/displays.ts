import type { EchoConnectionState, EchoEncryption, EchoProblem, PipelineState } from '@cortecho/shared';

// Labels and small formatters shared by the status, Echos and settings pages.
// They live here (not in a feature) so one Echo reads the same everywhere.

export const CONNECTION_LABELS: Record<EchoConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  disabled: 'Disabled',
};

export const PROBLEM_LABELS: Record<EchoProblem, string> = {
  'encryption-required': 'The Echo has an API key: add the key to this Echo',
  'invalid-key': 'The Echo rejects this API key',
  'key-not-set': 'The Echo has no key yet: run npm run echo-set-key',
  'unexpected-device': 'Another Echo is at this address: accept the new device or fix the address',
  'duplicate-node-name': 'Two Echos report the same name: give each Echo a unique name in its settings',
  'reply-address-missing': "The reply address is not set: add this computer's address in Settings → Network",
};

export const ENCRYPTION_LABELS: Record<EchoEncryption, string> = {
  noise: 'Secured',
  plaintext: 'Not secured',
};

export const PIPELINE_LABELS: Record<PipelineState, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  announcing: 'Announcing',
};

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatSeconds(ms: number | undefined): string {
  return ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`;
}

/** A saved setting value as the history shows it (never a secret's value). */
export function formatSettingValue(
  value: unknown,
  scope: 'global' | 'device' = 'global',
  optionLabels?: Record<string, string>,
): string {
  if (value === null || value === undefined) return scope === 'device' ? '(inherited)' : '(default)';
  if (typeof value === 'string') {
    if (value === '') return '(empty)';
    return optionLabels?.[value] ?? value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : value.join(', ');
  return JSON.stringify(value);
}
