import { createFileRoute } from '@tanstack/react-router';
import { EchoPage } from '@/features/devices/pages/EchoPage.tsx';
import { type EchoTab, isEchoTab } from '@/features/devices/tabs.ts';

/** `?tab=overview|connection|prompt|tuning|delete`; anything else falls back to overview. */
export const Route = createFileRoute('/echos/$id')({
  validateSearch: (search: Record<string, unknown>): { tab: EchoTab } => ({
    tab: isEchoTab(search.tab) ? search.tab : 'overview',
  }),
  component: EchoRoute,
});

function EchoRoute() {
  const { id } = Route.useParams();
  const { tab } = Route.useSearch();
  return <EchoPage deviceId={Number(id)} tab={tab} />;
}
