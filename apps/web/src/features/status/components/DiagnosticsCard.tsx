import type { DoctorCheck, DoctorReport } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { StethoscopeIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { apiRequest } from '@/lib/api-client.ts';

const LABEL: Record<DoctorCheck['status'], string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  skip: 'Skipped',
};

const TONE: Record<DoctorCheck['status'], string> = {
  pass: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  fail: 'text-destructive',
  skip: 'text-muted-foreground',
};

/**
 * The same checks as `cortecho doctor`, run on demand. They are read-only and
 * never open a second voice-assistant subscription.
 */
export function DiagnosticsCard() {
  const doctor = useQuery({
    queryKey: ['doctor'],
    queryFn: () => apiRequest<DoctorReport>('/api/doctor'),
    enabled: false,
    staleTime: 15_000,
  });

  const report = doctor.data;
  return (
    <section aria-label="Diagnostics" className="rounded-xl border bg-card shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <StethoscopeIcon aria-hidden="true" className="size-4" />
            Diagnostics
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The same checks as <code>cortecho doctor</code>. Nothing is changed.
          </p>
        </div>
        <Button variant="outline" onClick={() => doctor.refetch()} disabled={doctor.isFetching}>
          {doctor.isFetching ? 'Running…' : 'Run diagnostics'}
        </Button>
      </div>

      {doctor.isError ? (
        <p role="alert" className="px-4 py-4 text-sm text-destructive">
          {doctor.error.message}
        </p>
      ) : report ? (
        <ul className="divide-y">
          {report.checks.map((entry) => (
            <li key={entry.name} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{entry.name}</span>
                <span className={`text-xs font-semibold uppercase tracking-wide ${TONE[entry.status]}`}>
                  {LABEL[entry.status]}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">{entry.detail}</p>
              {entry.fix ? <p className="mt-1 text-xs">Fix: {entry.fix}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          Run the checks to see whether the settings, the Echo links, the reply address and OpenAI are usable.
        </p>
      )}
    </section>
  );
}
