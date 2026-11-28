import type { DeviceStatus, McpServerDetail, McpToolPolicy, McpToolStatus } from '@cortecho/shared';
import { MAX_SERVER_INSTRUCTIONS_CHARS } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ExternalLinkIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { useSaveDeviceSettings } from '@/features/devices/api/devices.mutations.ts';
import { deviceSettingsQueryOptions, devicesQueryOptions } from '@/features/devices/api/devices.queries.ts';
import { isApiError } from '@/lib/api-client.ts';
import {
  useCompleteOAuth,
  useDeleteConnector,
  useDisconnectOAuth,
  useReconnectConnector,
  useRefreshConnectorTools,
  useSetToolPolicies,
  useStartOAuth,
  useUpdateConnector,
} from '../api/connectors.mutations.ts';
import { connectorQueryOptions } from '../api/connectors.queries.ts';
import { TryToolDialog } from './TryToolDialog.tsx';

const TABS = ['connection', 'account', 'tools', 'prompt', 'echos', 'delete'] as const;
type SheetTab = (typeof TABS)[number];

/**
 * The Manage sheet: Connection, Account, Tools, Prompt, Echos and Delete.
 * Each tab saves its own fields, because OAuth and tool syncs are runtime
 * operations, not part of the versioned settings document. On a phone the
 * dialog is full screen; on desktop it is a wide panel.
 */
export function ConnectorSheet({
  connectorId,
  open,
  onOpenChange,
  initialTab = 'connection',
}: {
  connectorId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SheetTab;
}) {
  const detail = useQuery({
    ...connectorQueryOptions(connectorId ?? 0),
    enabled: open && connectorId !== null,
  });
  const connector = detail.data;
  const [tab, setTab] = useState<SheetTab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100dvh-1rem)] max-h-none w-[calc(100%-1rem)] max-w-3xl sm:h-auto sm:max-h-[calc(100dvh-3rem)]">
        <DialogHeader>
          <DialogTitle>{connector?.name ?? 'Connector'}</DialogTitle>
          <DialogDescription>{connector ? connector.url : 'Loading the connector…'}</DialogDescription>
        </DialogHeader>

        {detail.isPending || !connector ? (
          <div className="space-y-3" role="status" aria-busy="true">
            <span className="sr-only">Loading the connector…</span>
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as SheetTab)}>
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              {TABS.map((value) => (
                <TabsTrigger key={value} value={value} className="min-h-9 px-3">
                  {value === 'delete' ? 'Delete' : value.charAt(0).toUpperCase() + value.slice(1)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="connection">
              <ConnectionTab connector={connector} />
            </TabsContent>
            <TabsContent value="account">
              <AccountTab connector={connector} />
            </TabsContent>
            <TabsContent value="tools">
              <ToolsTab connector={connector} />
            </TabsContent>
            <TabsContent value="prompt">
              <PromptTab connector={connector} />
            </TabsContent>
            <TabsContent value="echos">
              <EchosTab connector={connector} />
            </TabsContent>
            <TabsContent value="delete">
              <DeleteTab connector={connector} onDeleted={() => onOpenChange(false)} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionTab({ connector }: { connector: McpServerDetail }) {
  const update = useUpdateConnector(connector.id);
  const reconnect = useReconnectConnector();
  const [form, setForm] = useState({
    name: connector.name,
    url: connector.url,
    transport: connector.transport === 'sse' ? 'sse' : 'streamable-http',
    timeoutMs: String(connector.timeoutMs),
    maxResultChars: String(connector.maxResultChars),
    enabled: connector.enabled,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setForm({
      name: connector.name,
      url: connector.url,
      transport: connector.transport === 'sse' ? 'sse' : 'streamable-http',
      timeoutMs: String(connector.timeoutMs),
      maxResultChars: String(connector.maxResultChars),
      enabled: connector.enabled,
    });
    setErrors({});
  }, [
    connector.name,
    connector.url,
    connector.transport,
    connector.timeoutMs,
    connector.maxResultChars,
    connector.enabled,
  ]);

  function save() {
    update.mutate(
      {
        name: form.name.trim(),
        url: form.url.trim(),
        transport: form.transport as 'streamable-http' | 'sse',
        timeoutMs: Number(form.timeoutMs) || 10_000,
        maxResultChars: Number(form.maxResultChars) || 4000,
        enabled: form.enabled,
      },
      {
        onSuccess: () => toast.success('Connection saved.'),
        onError: (error) => {
          if (isApiError(error)) {
            setErrors(error.fields);
            toast.error(error.fields._root ?? error.message);
          } else toast.error(error.message);
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="sheet-name">
          <Input
            id="sheet-name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Transport" htmlFor="sheet-transport">
          <select
            id="sheet-transport"
            value={form.transport}
            onChange={(event) => setForm({ ...form, transport: event.target.value })}
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="streamable-http">Streamable HTTP (SSE fallback)</option>
            <option value="sse">HTTP + SSE</option>
          </select>
        </Field>
      </div>
      <Field label="Server URL" htmlFor="sheet-url" error={errors.url}>
        <Input
          id="sheet-url"
          value={form.url}
          spellCheck={false}
          aria-invalid={Boolean(errors.url) || undefined}
          onChange={(event) => setForm({ ...form, url: event.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tool timeout (ms)" htmlFor="sheet-timeout">
          <Input
            id="sheet-timeout"
            type="number"
            min={500}
            max={20000}
            value={form.timeoutMs}
            onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })}
          />
        </Field>
        <Field label="Maximum result (characters)" htmlFor="sheet-result">
          <Input
            id="sheet-result"
            type="number"
            min={500}
            max={16000}
            value={form.maxResultChars}
            onChange={(event) => setForm({ ...form, maxResultChars: event.target.value })}
          />
        </Field>
      </div>
      <label
        htmlFor="sheet-enabled"
        className="flex items-center justify-between gap-3 rounded-lg border p-3"
      >
        <span>
          <span className="block text-sm font-medium">Enabled</span>
          <span className="text-xs text-muted-foreground">
            Off closes the connection and removes its tools.
          </span>
        </span>
        <Switch
          id="sheet-enabled"
          checked={form.enabled}
          onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
        />
      </label>

      <StatusBlock connector={connector} />

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save connection'}
        </Button>
        <Button
          variant="outline"
          disabled={reconnect.isPending}
          onClick={() =>
            reconnect.mutate(connector.id, {
              onSuccess: () => toast.success('Reconnecting…'),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <RefreshCwIcon aria-hidden="true" />
          {reconnect.isPending ? 'Reconnecting…' : 'Reconnect now'}
        </Button>
      </div>
    </div>
  );
}

function StatusBlock({ connector }: { connector: McpServerDetail }) {
  return (
    <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">State</dt>
        <dd className="font-medium">{connector.state.replace('_', ' ')}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Protocol</dt>
        <dd className="font-mono text-xs">{connector.protocolVersion ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Last connected</dt>
        <dd>{connector.lastConnectedAt ? new Date(connector.lastConnectedAt).toLocaleString() : '—'}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Transport</dt>
        <dd>{connector.transportUsed ?? connector.transport}</dd>
      </div>
      {connector.lastError && (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Last error</dt>
          <dd className="break-words text-destructive">{connector.lastError}</dd>
        </div>
      )}
    </dl>
  );
}

function AccountTab({ connector }: { connector: McpServerDetail }) {
  const start = useStartOAuth(connector.id);
  const disconnect = useDisconnectOAuth(connector.id);
  const complete = useCompleteOAuth(connector.id);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [progress, setProgress] = useState(false);

  if (connector.authType !== 'oauth') {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {connector.authType === 'headers'
            ? 'This connector uses a saved header or API token. Change it by re-adding the connector; the value is never shown again.'
            : 'This connector does not need a sign-in.'}
        </p>
        <StatusBlock connector={connector} />
      </div>
    );
  }

  function signIn() {
    // Open the tab synchronously: an async window.open after the request is
    // blocked by the browser's popup blocker (phones especially).
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    start.mutate(undefined, {
      onSuccess: ({ authorizationUrl }) => {
        if (tab && !tab.closed) tab.location.href = authorizationUrl;
        else window.open(authorizationUrl, '_blank', 'noopener,noreferrer');
        setProgress(true);
        toast.success('Finish signing in in the new tab. This tab updates when it comes back.');
        window.setTimeout(() => setProgress(false), 5 * 60_000);
      },
      onError: (error) => {
        tab?.close();
        toast.error(error.message);
      },
    });
  }

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Account</dt>
          <dd className="font-medium">{connector.accountLabel ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">State</dt>
          <dd className="font-medium">{connector.authState.replace('-', ' ')}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Granted scopes</dt>
          <dd className="break-words font-mono text-xs">{connector.grantedScope ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Token expires</dt>
          <dd>{connector.expiresAt ? new Date(connector.expiresAt).toLocaleString() : '—'}</dd>
        </div>
      </dl>

      {connector.authState === 'expired' && (
        <Alert variant="destructive">
          <AlertTitle>The token expired and could not be refreshed</AlertTitle>
          <AlertDescription>Sign in again to keep using this connector.</AlertDescription>
        </Alert>
      )}
      {connector.reason === 'insufficient-scope' && (
        <Alert>
          <AlertTitle>This connector needs more permissions</AlertTitle>
          <AlertDescription>Sign in again and accept the additional scopes.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={signIn} disabled={start.isPending}>
          <ExternalLinkIcon aria-hidden="true" />
          {start.isPending ? 'Starting…' : connector.authState === 'signed-in' ? 'Sign in again' : 'Sign in'}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" disabled={disconnect.isPending}>
              Disconnect account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {connector.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The stored token is revoked when the provider supports it and deleted here. The connector
                stays, signed out.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  disconnect.mutate(undefined, {
                    onSuccess: () => toast.success('Disconnected.'),
                    onError: (error) => toast.error(error.message),
                  })
                }
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {progress && <p className="text-xs text-muted-foreground">Waiting for the browser sign-in…</p>}

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-muted-foreground">
          The browser ended on a page that does not load?
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Copy the full address from the browser's address bar and paste it here (the manual flow for a
          localhost redirect).
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Callback URL"
            value={callbackUrl}
            placeholder="http://localhost:3000/api/mcp/oauth/callback?code=…&state=…"
            onChange={(event) => setCallbackUrl(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={!callbackUrl.trim() || complete.isPending}
            onClick={() =>
              complete.mutate(callbackUrl.trim(), {
                onSuccess: () => {
                  setCallbackUrl('');
                  toast.success('Signed in.');
                },
                onError: (error) => toast.error(error.message),
              })
            }
          >
            Finish sign-in
          </Button>
        </div>
      </details>
    </div>
  );
}

function ToolsTab({ connector }: { connector: McpServerDetail }) {
  const refresh = useRefreshConnectorTools();
  const policies = useSetToolPolicies(connector.id);
  const [tryTool, setTryTool] = useState<McpToolStatus | null>(null);

  function setPolicy(tool: McpToolStatus, policy: McpToolPolicy) {
    policies.mutate(
      { [tool.name]: policy },
      {
        onSuccess: () => toast.success(`${tool.title || tool.name}: ${policy}.`),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {connector.toolsEnabled} of {connector.toolsTotal} tools are offered to the agent.
          {connector.needsReview > 0 && ` ${connector.needsReview} need review.`}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={refresh.isPending}
          onClick={() =>
            refresh.mutate(connector.id, {
              onSuccess: () => toast.success('Synced with the server.'),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <RefreshCwIcon aria-hidden="true" /> Refresh
        </Button>
      </div>

      {connector.tools.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          This server lists no tools yet. Reconnect or refresh after the sign-in.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {connector.tools.map((tool) => (
            <li key={tool.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{tool.title || tool.name}</span>
                <code className="text-xs text-muted-foreground">{tool.exposedName}</code>
                {!tool.present && <Badge variant="outline">no longer listed</Badge>}
                {tool.review === 'new' && <Badge variant="destructive">new</Badge>}
                {tool.review === 'changed' && <Badge variant="destructive">changed</Badge>}
                {tool.annotations.readOnlyHint && <Badge variant="secondary">read-only</Badge>}
                {tool.annotations.destructiveHint && <Badge variant="destructive">destructive</Badge>}
                {tool.annotations.openWorldHint && <Badge variant="outline">open world</Badge>}
              </div>
              {tool.description && <p className="text-sm text-muted-foreground">{tool.description}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={`policy-${tool.id}`} className="text-xs text-muted-foreground">
                  Policy
                </Label>
                <select
                  id={`policy-${tool.id}`}
                  value={tool.policy}
                  onChange={(event) => setPolicy(tool, event.target.value as McpToolPolicy)}
                  className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                >
                  <option value="off">Off</option>
                  <option value="auto">Automatic</option>
                  <option value="confirm">Confirm by voice</option>
                </select>
                {tool.review !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={policies.isPending}
                    onClick={() => setPolicy(tool, tool.policy === 'off' ? 'auto' : tool.policy)}
                  >
                    <CheckIcon aria-hidden="true" /> Approve this definition
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!tool.present || tool.policy === 'off'}
                  onClick={() => setTryTool(tool)}
                >
                  Try
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tryTool && (
        <TryToolDialog
          connectorId={connector.id}
          tool={tryTool}
          open={Boolean(tryTool)}
          onOpenChange={(open) => {
            if (!open) setTryTool(null);
          }}
        />
      )}
    </div>
  );
}

function PromptTab({ connector }: { connector: McpServerDetail }) {
  const update = useUpdateConnector(connector.id);
  const [description, setDescription] = useState(connector.description);
  const [useInstructions, setUseInstructions] = useState(connector.useServerInstructions);

  useEffect(() => {
    setDescription(connector.description);
    setUseInstructions(connector.useServerInstructions);
  }, [connector.description, connector.useServerInstructions]);

  return (
    <div className="space-y-4">
      <Field
        label="What this account is (the model reads this)"
        htmlFor="sheet-description"
        help="One line: whose mailbox, which calendar, which home."
      >
        <Textarea
          id="sheet-description"
          rows={2}
          maxLength={300}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <label
        htmlFor="sheet-use-instructions"
        className="flex items-center justify-between gap-3 rounded-lg border p-3"
      >
        <span>
          <span className="block text-sm font-medium">Use the server's instructions</span>
          <span className="text-xs text-muted-foreground">
            Adds the server's own note (first {MAX_SERVER_INSTRUCTIONS_CHARS} characters) to the prompt.
          </span>
        </span>
        <Switch id="sheet-use-instructions" checked={useInstructions} onCheckedChange={setUseInstructions} />
      </label>
      {connector.serverInstructions && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Server instructions</p>
          <p className="whitespace-pre-wrap text-sm">{connector.serverInstructions}</p>
          {connector.serverInstructionsLength !== null &&
            connector.serverInstructionsLength > MAX_SERVER_INSTRUCTIONS_CHARS && (
              <p className="mt-2 text-xs text-muted-foreground">
                Cut at {MAX_SERVER_INSTRUCTIONS_CHARS} of {connector.serverInstructionsLength} characters; the
                model sees only the part shown.
              </p>
            )}
        </div>
      )}
      {(connector.serverName || connector.lastSyncedAt) && (
        <p className="text-xs text-muted-foreground">
          {connector.serverName &&
            `Server: ${connector.serverName}${connector.serverVersion ? ` ${connector.serverVersion}` : ''}`}
          {connector.serverName && connector.protocolVersion && ' · '}
          {connector.protocolVersion && `MCP ${connector.protocolVersion}`}
          {connector.lastSyncedAt &&
            `${connector.serverName || connector.protocolVersion ? ' · ' : ''}synced ${relativeTime(connector.lastSyncedAt)}`}
        </p>
      )}
      <Button
        disabled={update.isPending}
        onClick={() =>
          update.mutate(
            { description: description.trim(), useServerInstructions: useInstructions },
            {
              onSuccess: () => toast.success('Prompt saved.'),
              onError: (error) => toast.error(error.message),
            },
          )
        }
      >
        {update.isPending ? 'Saving…' : 'Save prompt'}
      </Button>
    </div>
  );
}

function EchosTab({ connector }: { connector: McpServerDetail }) {
  const devices = useQuery(devicesQueryOptions());
  if (devices.isPending) {
    return <Skeleton className="h-24 w-full" />;
  }
  const list = devices.data ?? [];
  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">No Echo is configured yet.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Turn this connector off for an Echo that should not read it (for example the kids' room). The change
        applies to that Echo's next turn.
      </p>
      <ul className="divide-y rounded-lg border">
        {list.map((device) => (
          <EchoAvailabilityRow key={device.id} device={device} connector={connector} />
        ))}
      </ul>
    </div>
  );
}

function EchoAvailabilityRow({ device, connector }: { device: DeviceStatus; connector: McpServerDetail }) {
  const document = useQuery(deviceSettingsQueryOptions(device.id));
  const save = useSaveDeviceSettings(device.id);
  const disabled = Array.isArray(document.data?.overrides['connectors.disabled'])
    ? (document.data?.overrides['connectors.disabled'] as string[])
    : [];
  const allowed = !disabled.includes(connector.slug);

  function toggle(next: boolean) {
    if (!document.data) return;
    const slugs = next
      ? disabled.filter((slug) => slug !== connector.slug)
      : [...new Set([...disabled, connector.slug])];
    save.mutate(
      {
        version: document.data.version,
        changes: { 'connectors.disabled': slugs },
      },
      {
        onSuccess: () =>
          toast.success(`${device.name}: ${next ? 'can use' : 'cannot use'} ${connector.name}.`),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 p-3">
      <span>
        <span className="block text-sm font-medium">{device.name}</span>
        <span className="text-xs text-muted-foreground">
          {device.kind === 'test' ? 'test device' : `${device.host}:${device.port}`}
        </span>
      </span>
      <Switch
        checked={allowed}
        disabled={document.isPending || save.isPending}
        aria-label={`${device.name} may use ${connector.name}`}
        onCheckedChange={toggle}
      />
    </li>
  );
}

function DeleteTab({ connector, onDeleted }: { connector: McpServerDetail; onDeleted: () => void }) {
  const remove = useDeleteConnector();
  return (
    <div className="space-y-3 rounded-xl border border-destructive/40 p-4">
      <h3 className="font-semibold text-destructive">Delete this connector</h3>
      <p className="text-sm text-muted-foreground">
        The connection closes, its tools leave the agent and its stored token is deleted. Turn history keeps
        the calls it made. This cannot be undone.
      </p>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={remove.isPending}>
            <Trash2Icon aria-hidden="true" /> Delete {connector.name}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {connector.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its tools stop being offered immediately. To use this service again you must add it again and
              sign in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                remove.mutate(connector.id, {
                  onSuccess: () => {
                    toast.success(`Deleted ${connector.name}.`);
                    onDeleted();
                  },
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The Prompt tab's tiny "synced 5 min ago" line; no library for one timestamp. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

export type { SheetTab };
