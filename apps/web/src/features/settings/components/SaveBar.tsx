import { Button } from '@/components/ui/button.tsx';

/**
 * The sticky bottom bar of a settings form: how many values are unsaved,
 * Discard and Save. It stays reachable on a phone (sticky, above the safe area).
 */
export function SaveBar({
  count,
  saving,
  onDiscard,
  onSave,
  saveLabel = 'Save',
  disabled = false,
}: {
  count: number;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
  disabled?: boolean;
}) {
  const label = count === 1 ? '1 unsaved change' : `${count} unsaved changes`;
  return (
    <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p aria-live="polite" className="text-sm font-medium">
          {count === 0 ? 'No unsaved changes' : label}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDiscard} disabled={count === 0 || saving}>
            Discard
          </Button>
          <Button type="button" onClick={onSave} disabled={count === 0 || saving || disabled}>
            {saving ? 'Saving…' : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
