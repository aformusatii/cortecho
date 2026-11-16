import { type DeviceStatus, MAX_DEVICE_PROMPT_LENGTH } from '@cortecho/shared';
import { FileTextIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { FullPromptDialog } from '@/features/settings/components/FullPromptDialog.tsx';
import { useUpdateDevice } from '../api/devices.mutations.ts';

const HELP =
  'Added to the assistant’s instructions for this Echo only, after the household prompt. Describe ' +
  'where this Echo stands and what “here” means: the room, which lights and devices are in it (with ' +
  'their Home Assistant names if you use them), who usually talks to it, and how it should answer ' +
  'here. Changes apply to the next request. Leave empty to use only the household prompt.';

const PLACEHOLDER =
  'This Echo is in the kitchen. “The light” means the ceiling light (light.kitchen_ceiling); ' +
  'the counter strip is light.kitchen_counter. People here are usually cooking: keep answers very ' +
  'short and offer a timer when it fits.';

/**
 * The per-Echo third prompt layer (§8.3). It saves on its own (PATCH prompt),
 * so the connection form and the tuning form are not touched.
 */
export function PromptTab({ device }: { device: DeviceStatus }) {
  const [prompt, setPrompt] = useState(device.prompt);
  const [promptOpen, setPromptOpen] = useState(false);
  const update = useUpdateDevice(device.id);
  const dirty = prompt !== device.prompt;

  function save() {
    update.mutate(
      { prompt },
      {
        onSuccess: () => toast.success('Prompt saved. It applies from the next request.'),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <div className="space-y-4">
      <section aria-label="Prompt for this Echo" className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="device-prompt" className="text-base font-semibold">
            Prompt for this Echo
          </Label>
          <span className="text-xs text-muted-foreground">
            {prompt.length} / {MAX_DEVICE_PROMPT_LENGTH} characters
          </span>
        </div>
        <p id="device-prompt-help" className="mt-1 text-sm text-muted-foreground">
          {HELP}
        </p>
        <Textarea
          id="device-prompt"
          value={prompt}
          rows={8}
          maxLength={MAX_DEVICE_PROMPT_LENGTH}
          placeholder={PLACEHOLDER}
          aria-describedby="device-prompt-help"
          onChange={(event) => setPrompt(event.target.value)}
          className="mt-3"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" onClick={save} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save prompt'}
          </Button>
          <Button type="button" variant="outline" onClick={() => setPrompt(device.prompt)} disabled={!dirty}>
            Discard
          </Button>
          <Button type="button" variant="outline" onClick={() => setPromptOpen(true)}>
            <FileTextIcon aria-hidden="true" /> Show the full prompt
          </Button>
        </div>
        {dirty && (
          <p className="mt-2 text-xs text-muted-foreground">
            Unsaved changes. The full prompt view shows the saved text.
          </p>
        )}
      </section>

      <FullPromptDialog open={promptOpen} onOpenChange={setPromptOpen} deviceId={device.id} />
    </div>
  );
}
