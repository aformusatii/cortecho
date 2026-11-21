import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import { ONBOARDING_LINKS } from './onboarding.ts';

/**
 * Step 3 (spec §5.1): the key is saved first (write-only, the AI itself needs
 * it) and then checked with `POST /api/setup/check-openai`, so a rejected key
 * is reported here instead of on the first question.
 */
export function OpenAiStep({
  value,
  error,
  notice,
  checking,
  onChange,
  onSubmit,
}: {
  value: string;
  /** A field error (server validation, e.g. too long). */
  error: string | null;
  /** "OpenAI rejected this key." / "Cortecho cannot reach OpenAI. …". */
  notice: string | null;
  checking: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <StepHeading>Connect OpenAI</StepHeading>
      <p className="text-sm text-muted-foreground">
        Cortecho uses OpenAI to understand you and to speak. You pay OpenAI per question; there is no
        subscription.{' '}
        <a
          href={ONBOARDING_LINKS.getKey}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Get a key ↗
        </a>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="onboarding-openai-key">API key</Label>
        <Input
          id="onboarding-openai-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={checking}
          aria-invalid={Boolean(error || notice) || undefined}
          aria-describedby={error ? 'onboarding-openai-key-error' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {error && (
          <p id="onboarding-openai-key-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {notice && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {notice}
        </p>
      )}
      <div aria-live="polite" className="text-sm text-muted-foreground">
        {checking && 'Checking your OpenAI key…'}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={checking} className="w-full sm:w-auto">
          {checking ? 'Checking…' : 'Check and continue'}
        </Button>
      </div>
    </form>
  );
}
