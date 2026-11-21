import { createFileRoute } from '@tanstack/react-router';
import { StatusRoute } from '@/features/status/pages/StatusRoute.tsx';

// Route files stay thin: the status page lives in features/status, and its
// route wrapper owns the first-launch redirect (spec §8.3).
export const Route = createFileRoute('/')({
  component: StatusRoute,
});
