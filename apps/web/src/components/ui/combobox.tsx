'use client';

import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import * as React from 'react';

// A text input with a suggestion dropdown that always lists every option.
// A native <datalist> filters its entries by the value already in the input, so
// once a model was chosen only that model stayed visible; this popup never
// filters, and the input still accepts a value that is not in the list.

export type ComboboxProps = {
  id: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  /** Shown in the list and the chevron button labels (e.g. "Model"). */
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  className?: string;
};

function Combobox({
  id,
  value,
  options,
  onChange,
  label,
  disabled = false,
  invalid = false,
  describedBy,
  placeholder,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = `${id}-options`;
  const optionId = (index: number) => `${id}-option-${index}`;

  // Keep the keyboard-highlighted option visible in the scrollable popup.
  React.useEffect(() => {
    if (!open || active < 0) return;
    const item = listRef.current?.children[active];
    if (item instanceof HTMLElement) item.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // The chevron opens the list, but typing is what a combobox is for: keep the
  // caret in the input so a keypress filters nothing and extends the value.
  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const showAll = () => {
    if (disabled || options.length === 0) return;
    setActive(-1);
    setOpen(true);
  };

  const choose = (option: string) => {
    onChange(option);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        showAll();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => {
        if (options.length === 0) return -1;
        if (current < 0) return step > 0 ? 0 : options.length - 1;
        return (current + step + options.length) % options.length;
      });
      return;
    }
    if (!open) return;
    if (event.key === 'Enter') {
      const option = options[active];
      if (option !== undefined) {
        event.preventDefault();
        choose(option);
      }
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div ref={anchorRef} className={cn('relative w-full max-w-md', className)}>
          <input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={placeholder}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={value}
            onClick={() => {
              if (!open) showAll();
            }}
            onKeyDown={onKeyDown}
            onChange={(event) => onChange(event.target.value)}
            className="h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-1 pr-10 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
          />
          {options.length > 0 && (
            <Popover.Trigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Show all ${label} options`}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <ChevronDownIcon aria-hidden="true" className="size-4" />
              </button>
            </Popover.Trigger>
          )}
        </div>
      </Popover.Anchor>
      <Popover.Content
        sideOffset={4}
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          // Clicking the input again must not close the list it just opened.
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
        onFocusOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
        className="z-50 max-h-72 w-(--radix-popover-trigger-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
      >
        <div id={listId} ref={listRef} role="listbox" aria-label={`${label} options`}>
          {options.map((option, index) => (
            <button
              key={option}
              id={optionId(index)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option === value}
              // preventDefault keeps focus in the input, so typing continues.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
              className={cn(
                'flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
                index === active && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="truncate">{option}</span>
              {option === value && <CheckIcon aria-hidden="true" className="size-4 shrink-0" />}
            </button>
          ))}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

export { Combobox };
