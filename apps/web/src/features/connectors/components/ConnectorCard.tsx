import type { McpAuthState, McpConnectionState, McpServerStatus } from '@cortecho/shared';
import { Settings2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { StatusDot } from '@/features/status/components/StatusDot.tsx';
import { useUpdateConnector } from '../api/connectors.mutations.ts';

const STATE_TONE = {
  connected: 'good',
  connecting: 'warn',
  needs_auth: 'warn',
  disabled: 'off',
  error: 'bad',
} as const;

const STATE_LABEL: Record<McpConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  needs_auth: 'Needs sign-in',
  disabled: 'Off',
  error: 'Error',
};

function authLine(connector: McpServerStatus): string {
  if (connector.authType === 'none') return 'No sign-in needed';
  if (connector.authType === 'headers') return 'API token saved';
  const labels: Record<McpAuthState, string> = {
    'not-required': 'No sign-in needed',
    'signed-out': 'Not signed in',
    'signed-in': connector.accountLabel ? `Signed in as ${connector.accountLabel}` : 'Signed in',
    expiring: 'Token expiring soon',
    expired: 'Token expired',
  };
  return labels[connector.authState];
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/mcp\/?$/, '')}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function ConnectorCard({ connector, onManage }: { connector: McpServerStatus; onManage: () => void }) {
  const update = useUpdateConnector(connector.id);
  const confirmCount = connector.toolsTotal - connector.toolsEnabled;

  function toggle(enabled: boolean) {
    update.mutate(
      { enabled },
      {
        onSuccess: () => toast.success(enabled ? `${connector.name} is on.` : `${connector.name} is off.`),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusDot tone={STATE_TONE[connector.state]}>{STATE_LABEL[connector.state]}</StatusDot>
          <span className="truncate font-medium">{connector.name}</span>
          {connector.needsReview > 0 && (
            <Badge variant="destructive">
              {connector.needsReview} {connector.needsReview === 1 ? 'tool needs' : 'tools need'} review
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{hostOf(connector.url)}</p>
        <p className="text-sm text-muted-foreground">
          {connector.toolsEnabled} of {connector.toolsTotal} tools on
          {confirmCount > 0 && connector.toolsEnabled > 0 ? ` · ${confirmCount} off` : ''} ·{' '}
          {authLine(connector)}
        </p>
        {connector.lastError && (
          <p className="line-clamp-2 text-xs text-destructive">{connector.lastError}</p>
        )}
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">
        <Button variant="outline" onClick={onManage} className="min-h-10">
          <Settings2Icon aria-hidden="true" /> Manage
        </Button>
        <Switch
          checked={connector.enabled}
          disabled={update.isPending}
          aria-label={`${connector.enabled ? 'Turn off' : 'Turn on'} ${connector.name}`}
          onCheckedChange={toggle}
        />
      </div>
    </li>
  );
}
