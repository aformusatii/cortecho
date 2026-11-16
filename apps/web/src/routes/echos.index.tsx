import { createFileRoute } from '@tanstack/react-router';
import { EchosPage } from '@/features/devices/pages/EchosPage.tsx';

// Route files stay thin: the page lives in features/devices.
export const Route = createFileRoute('/echos/')({
  component: EchosPage,
});
