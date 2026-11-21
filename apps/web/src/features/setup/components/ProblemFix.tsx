import type { DeviceStatus } from '@cortecho/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { KeyRepairDialog } from './KeyRepairDialog.tsx';

/**
 * Repairs for device problems (spec §5.4): each one opens the step that fixes
 * it. `duplicate-node-name` has no action (the owner must rename the Echo on
 * the Echo itself), so it stays a plain sentence.
 */
export function ProblemFix({ device }: { device: DeviceStatus }) {
  const [repairOpen, setRepairOpen] = useState(false);

  if (device.problem === 'encryption-required' || device.problem === 'invalid-key') {
    return (
      <>
        <Button type="button" size="sm" variant="outline" onClick={() => setRepairOpen(true)}>
          Fix
        </Button>
        <KeyRepairDialog device={device} open={repairOpen} onOpenChange={setRepairOpen} />
      </>
    );
  }

  if (device.problem === 'reply-address-missing') {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/settings" search={{ tab: 'general' }} hash="section-network">
          Fix
        </Link>
      </Button>
    );
  }

  return null;
}
