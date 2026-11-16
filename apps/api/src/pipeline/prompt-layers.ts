import type { PromptLayer, Settings } from '@cortecho/shared';
import { type ListenToolOptions, listenPolicy } from './listen-tool.ts';
import { SEARCH_POLICY } from './search-policy.ts';

/**
 * The instructions are rebuilt on every request from three layers:
 *
 *   1. the household prompt (owner, global) - who the assistant is, the home;
 *   2. the speaker rules (code) - how the Echo works, the tool policies, the
 *      time zone and locale; they follow the settings (no search policy when
 *      web search is off, no listen policy unless FOLLOW_UP_MODE is `tool`);
 *   3. this Echo (owner, per device) - free text for one speaker.
 *
 * Layers 1 and 2 come first and are the same for every Echo, so OpenAI's
 * cached prompt prefix is shared. Only the tail differs. The per-turn date
 * and time stay in the message, not here, so the prefix stays stable.
 */
export const BASE_RULES = [
  'You are a voice assistant speaking through a small smart speaker in a home.',
  'Your answer is converted to speech, so answer in one to three short sentences.',
  'Never use markdown, lists, emojis, URLs or code. Spell out symbols and units.',
  'The current date and time come with every request; use them for questions about the time, date or day.',
  'Use the tools when they help; never guess device states.',
  'If a request is unclear, ask one short question back.',
] as const;

/**
 * Told to the model only when a per-Echo prompt follows: it is the last block
 * and wins for that speaker.
 */
export const SPEAKER_BRIDGE =
  'The last section describes the speaker you are talking through, written by the owner. Use it for what "here", "this room" and devices named without a room mean. Where it differs from the instructions above, it wins for this speaker.';

export type PromptDevice = {
  name: string;
  /** The owner's free text for this Echo; empty = no third layer. */
  prompt: string;
};

export type PromptInput = {
  settings: Settings;
  listenTool?: ListenToolOptions;
  /** Absent for /api/ask without a device and before the devices phase. */
  device?: PromptDevice | null;
};

export function buildPromptLayers({ settings, listenTool, device }: PromptInput): PromptLayer[] {
  const layer1 = settings.assistant.householdPrompt.trim();
  const layer3 = device?.prompt.trim() ?? '';

  const layer2Parts = [
    BASE_RULES.join(' '),
    settings.agent.webSearch ? SEARCH_POLICY : 'Web search is unavailable; do not claim to have searched.',
  ];
  if (listenTool) layer2Parts.push(listenPolicy(listenTool));
  layer2Parts.push(
    `The user's time zone is ${settings.assistant.timeZone} and locale ${settings.assistant.locale}.`,
  );
  if (layer3) layer2Parts.push(SPEAKER_BRIDGE);

  return [
    { layer: 1, title: 'Household', text: layer1 },
    { layer: 2, title: 'Speaker rules, built in', text: layer2Parts.join('\n') },
    ...(layer3 ? [{ layer: 3 as const, title: `This Echo ("${device?.name ?? ''}")`, text: layer3 }] : []),
  ];
}

/** The assembled instructions, exactly as the next request sends them. */
export function buildInstructions(input: PromptInput): string {
  return buildPromptLayers(input)
    .map((layer) => layer.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}
