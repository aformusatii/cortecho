import { type DeviceKind, type DiscoveredEcho, isPrivateIpv4 } from '@cortecho/shared';

/**
 * The Add Echo flow's shared pieces: the state the machine moves through, the
 * copy's links, and the reply-address prefill (spec §5.2).
 */

export const FLOW_STEPS = ['choose', 'confirm', 'identify', 'name', 'try', 'done'] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** The Echo the flow is adding. `discovered` is set when it came from the list. */
export type FlowTarget = {
  host: string;
  port: number;
  kind: DeviceKind;
  discovered: DiscoveredEcho | null;
  /** The friendly name (or the node name / address) the headings show. */
  label: string;
};

export type FlowProblemKind = 'unreachable' | 'not-an-echo' | 'already-added' | 'failed';

export type FlowProblem = {
  kind: FlowProblemKind;
  message: string;
  /** The error code and the Echo's answer, as the detail line (§5.7). */
  detail?: string;
  deviceId?: number;
  name?: string;
};

export type FlowState =
  | {
      step: 'choose';
      manual: boolean;
      advanced: boolean;
      host: string;
      port: string;
      kind: DeviceKind;
      /** The radio choice of the discovered list. */
      selectedMac: string | null;
      showIgnored: boolean;
      errors: Record<string, string>;
    }
  | {
      step: 'confirm';
      target: FlowTarget;
      mode: 'ready' | 'adopting' | 'adopted' | 'needs-key' | 'problem';
      key: string;
      keyError: string | null;
      problem: FlowProblem | null;
    }
  | {
      step: 'identify';
      deviceId: number;
      status: 'connecting' | 'playing' | 'asking' | 'quiet' | 'address';
      address: string;
      addressError: string | null;
      soundError: string | null;
      /** The Echo fetched the chime but did not report finishing (spec §5.2). */
      notConfirmed: boolean;
    }
  | { step: 'name'; deviceId: number; value: string; error: string | null }
  | { step: 'try'; deviceId: number; startedAt: number }
  | { step: 'done'; deviceId: number };

/** Where the docs explain the things the wizard only mentions. */
export const DOC_LINKS = {
  removeKey: 'https://github.com/aformusatii/cortecho/blob/main/docs/echo-setup.md#the-api-key',
  pairing: 'https://github.com/aformusatii/cortecho/blob/main/docs/echo-setup.md#several-echos',
} as const;

/** The room chips of Step 4; they only fill the field. */
export const NAME_CHIPS = ['Kitchen', 'Living room', 'Bedroom', 'Office', 'Hall', "Kids' room"] as const;

/**
 * The address the Echo can download replies from (spec §5.2 Step 3). In order:
 * the saved setting, then the address this page was opened with when its host
 * is a private IPv4. The Echo link's local address is only known server-side
 * and is already the server's fallback, so it is not used here.
 */
export function replyAddressPrefill(setting: string, origin: string): string {
  const saved = setting.trim();
  if (saved !== '') return saved;
  try {
    const url = new URL(origin);
    if (isPrivateIpv4(url.hostname)) return url.origin;
  } catch {
    // A missing or odd origin simply has no suggestion.
  }
  return '';
}

/** "Echo Dot 2 cea6ae" for the headings; the address when the name is unknown. */
export function targetLabel(target: FlowTarget): string {
  return target.label || target.host;
}

/** The line under an error, for support (§5.7): the code and the answer. */
export function problemDetail(code: string, message: string): string {
  return `${code} · ${message}`;
}
