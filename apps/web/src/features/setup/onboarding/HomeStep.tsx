import { SETTING_BY_KEY, type SettingDescriptor } from '@cortecho/shared';
import { Button } from '@/components/ui/button.tsx';
import { SettingField } from '@/features/settings/components/SettingField.tsx';
import { StepHeading } from '../components/StepHeading.tsx';
import { timeZoneSuggestions } from './onboarding.ts';

function descriptor(key: string): SettingDescriptor {
  const found = SETTING_BY_KEY.get(key);
  if (!found) throw new Error(`No descriptor for ${key}`);
  return found;
}

const TIME_ZONE = descriptor('assistant.timeZone');
const LOCALE = descriptor('assistant.locale');
// Built once: the list has hundreds of zones and never changes.
const TIME_ZONES = timeZoneSuggestions();

/**
 * Step 2 (spec §5.1): the two settings the assistant's time, dates and
 * language come from. Both are written in one versioned save, so the store and
 * its history see a single change.
 */
export function HomeStep({
  timeZone,
  locale,
  errors,
  pending,
  onTimeZone,
  onLocale,
  onNext,
}: {
  timeZone: string;
  locale: string;
  errors: Record<string, string>;
  pending: boolean;
  onTimeZone: (value: string) => void;
  onLocale: (value: string) => void;
  onNext: () => void;
}) {
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <StepHeading>Your home</StepHeading>
      <p className="text-sm text-muted-foreground">
        Cortecho uses these for the time, dates and the language it speaks.
      </p>
      <div className="divide-y">
        <SettingField
          descriptor={TIME_ZONE}
          value={timeZone}
          error={errors['assistant.timeZone']}
          suggestions={TIME_ZONES}
          onChange={(value) => onTimeZone(typeof value === 'string' ? value : '')}
        />
        <SettingField
          descriptor={LOCALE}
          value={locale}
          error={errors['assistant.locale']}
          onChange={(value) => onLocale(typeof value === 'string' ? value : '')}
        />
      </div>
      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Saving…' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
