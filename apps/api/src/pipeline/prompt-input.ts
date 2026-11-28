import type { Settings } from '@cortecho/shared';
import type { ToolRegistry, ToolSet } from '../tools/registry.ts';
import { listenToolOptions } from './listen-tool.ts';
import type { PromptDevice, PromptInput } from './prompt-layers.ts';

/**
 * The full prompt input a turn sends. The connector list and the confirm flag
 * come from the turn's frozen tool set, so a preview and the model can never
 * disagree about which connectors (and notes) are in the prompt.
 */
export function turnPromptInput({
  settings,
  device,
  toolSet,
}: {
  settings: Settings;
  device?: PromptDevice | null;
  toolSet: ToolSet;
}): PromptInput {
  return {
    settings,
    listenTool: listenToolOptions(settings),
    device,
    connectors: toolSet.connectors(),
    hasConfirmTools: toolSet.hasConfirmTools(),
  };
}

/**
 * The preview route's version: build the same tool snapshot a turn would build
 * (memory only, no connector I/O) and then the same input.
 */
export function previewPromptInput({
  settings,
  device,
  deviceId,
  tools,
}: {
  settings: Settings;
  device?: PromptDevice | null;
  deviceId: number | null;
  tools: ToolRegistry;
}): PromptInput {
  return turnPromptInput({ settings, device, toolSet: tools.snapshot({ settings, deviceId }) });
}
