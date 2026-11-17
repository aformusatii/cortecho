import type { McpServerStatus } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { connectorCatalogQueryOptions, connectorsQueryOptions } from '../api/connectors.queries.ts';
import { AddConnectorDialog } from '../components/AddConnectorDialog.tsx';
import { ConnectorCard } from '../components/ConnectorCard.tsx';
import { ConnectorSheet, type SheetTab } from '../components/ConnectorSheet.tsx';

/**
 * Settings → Connectors. A runtime page, not part of the versioned settings
 * document: every connector saves on its own and OAuth/tool syncs happen live.
 * The list polls, so the tab that started a sign-in turns green while the
 * authorization tab is still open.
 */
export function ConnectorsTab({
  serverId,
  auth,
  reason,
  onConsumed,
}: {
  serverId?: number;
  auth?: 'ok' | 'error';
  reason?: string;
  onConsumed: () => void;
}) {
  const connectors = useQuery(connectorsQueryOptions());
  const catalog = useQuery(connectorCatalogQueryOptions());
  const [addOpen, setAddOpen] = useState(false);
  const [manageId, setManageId] = useState<number | null>(null);
  const [manageTab, setManageTab] = useState<SheetTab>('connection');

  const list = connectors.data ?? [];
  const totalTools = useMemo(
    () => list.filter((connector) => connector.enabled).reduce((sum, item) => sum + item.toolsEnabled, 0),
    [list],
  );
  const needsReview = useMemo(() => list.reduce((sum, item) => sum + item.needsReview, 0), [list]);

  useEffect(() => {
    if (serverId !== undefined) {
      setManageId(serverId);
      setManageTab(auth === 'ok' ? 'tools' : 'account');
    }
    if (auth === 'ok') toast.success('Connector signed in.');
    if (auth === 'error') {
      toast.error(
        reason === 'state'
          ? 'That sign-in link expired or was already used. Start it again.'
          : 'The sign-in did not complete. Start it again from the Account tab.',
      );
    }
    if (serverId !== undefined || auth !== undefined) onConsumed();
  }, [serverId, auth, reason, onConsumed]);

  function openManage(connector: McpServerStatus, tab: SheetTab = 'connection') {
    setManageId(connector.id);
    setManageTab(tab);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Tools from these services are offered to the voice agent. Each connector keeps one live
            connection; nothing is opened during a turn.
          </p>
          <p className="mt-1 text-sm font-medium" data-testid="connector-tool-count">
            {totalTools} {totalTools === 1 ? 'tool' : 'tools'} offered
            {needsReview > 0 && ` · ${needsReview} need review`}
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <PlusIcon aria-hidden="true" /> Add connector
        </Button>
      </div>

      {catalog.data && !catalog.data.secretKeyConfigured && (
        <Alert>
          <ShieldCheckIcon aria-hidden="true" />
          <AlertTitle>CORTECHO_SECRET_KEY is not set</AlertTitle>
          <AlertDescription>
            Connectors without authentication work. For API keys and OAuth, generate a key with{' '}
            <code>openssl rand -base64 32</code>, set <code>CORTECHO_SECRET_KEY</code> and restart. Without
            it, tokens cannot be stored encrypted.
          </AlertDescription>
        </Alert>
      )}

      {totalTools > 25 && (
        <Alert>
          <AlertTitle>{totalTools} connector tools are offered</AlertTitle>
          <AlertDescription>
            OpenAI recommends a small tool set; every tool adds prompt cost and model hesitation. Turn off
            what you do not use, or limit connectors per Echo.
          </AlertDescription>
        </Alert>
      )}

      {connectors.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading connectors…</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : connectors.isError ? (
        <div role="alert" className="rounded-xl border bg-card p-6 text-center">
          <p className="font-medium">Could not load the connectors</p>
          <p className="text-sm text-muted-foreground">{connectors.error.message}</p>
          <Button variant="outline" className="mt-3" onClick={() => connectors.refetch()}>
            Try again
          </Button>
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">No connectors yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Add Gmail, Google Calendar, Home Assistant or any MCP server. Its tools join the voice agent on
            the next turn, with no restart.
          </p>
          <Button className="mt-4" onClick={() => setAddOpen(true)}>
            <PlusIcon aria-hidden="true" /> Add your first connector
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-xs">
          {list.map((connector) => (
            <ConnectorCard key={connector.id} connector={connector} onManage={() => openManage(connector)} />
          ))}
        </ul>
      )}

      <AddConnectorDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(id) => {
          setManageId(id);
          setManageTab('account');
        }}
      />
      <ConnectorSheet
        connectorId={manageId}
        open={manageId !== null}
        initialTab={manageTab}
        onOpenChange={(open) => {
          if (!open) setManageId(null);
        }}
      />
    </div>
  );
}
