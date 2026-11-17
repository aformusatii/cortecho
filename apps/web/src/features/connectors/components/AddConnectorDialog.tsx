import type { McpCatalogEntry, McpServerCreate } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { apiRequest, isApiError } from '@/lib/api-client.ts';
import { useCreateConnector } from '../api/connectors.mutations.ts';
import { connectorCatalogQueryOptions } from '../api/connectors.queries.ts';

type HeaderRow = { name: string; value: string };

type Form = {
  catalogId: string;
  name: string;
  slug: string;
  url: string;
  description: string;
  transport: 'streamable-http' | 'sse';
  authType: 'none' | 'headers' | 'oauth';
  headers: HeaderRow[];
  registration: 'auto' | 'preregistered';
  clientId: string;
  clientSecret: string;
  scopes: string;
  extraAuthParams: Record<string, string>;
  authorizationServer: string;
  sendResource: boolean;
  timeoutMs: string;
  maxResultChars: string;
};

const EMPTY: Form = {
  catalogId: 'custom',
  name: '',
  slug: '',
  url: '',
  description: '',
  transport: 'streamable-http',
  authType: 'none',
  headers: [{ name: 'Authorization', value: '' }],
  registration: 'auto',
  clientId: '',
  clientSecret: '',
  scopes: '',
  extraAuthParams: {},
  authorizationServer: '',
  sendResource: true,
  timeoutMs: '10000',
  maxResultChars: '4000',
};

function formFor(entry: McpCatalogEntry): Form {
  const auth = entry.auth;
  return {
    ...EMPTY,
    catalogId: entry.id,
    name: entry.id === 'custom' ? '' : entry.label,
    slug: entry.suggestedSlug,
    url: entry.url ?? '',
    description: entry.defaultDescription,
    transport: entry.transport,
    authType: auth.type,
    headers:
      auth.type === 'headers'
        ? auth.fields.map((field) => ({ name: field.header, value: '' }))
        : [{ name: 'Authorization', value: '' }],
    registration: auth.type === 'oauth' ? auth.registration : 'auto',
    scopes: auth.type === 'oauth' ? (auth.scopes ?? []).join('\n') : '',
    extraAuthParams: auth.type === 'oauth' ? (auth.extraAuthParams ?? {}) : {},
    authorizationServer: auth.type === 'oauth' ? (auth.authorizationServer ?? '') : '',
    sendResource: auth.type === 'oauth' ? (auth.sendResource ?? true) : true,
  };
}

/**
 * Add a connector in two steps: a catalog card, then only the fields that
 * card needs. "Custom MCP server" is always available, so an unlisted server
 * works too. Saving an OAuth connector opens the authorization URL in a new
 * tab (never a popup: phones block those and SSO may run first).
 */
export function AddConnectorDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const catalog = useQuery(connectorCatalogQueryOptions());
  const create = useCreateConnector();
  const [step, setStep] = useState<'catalog' | 'form'>('catalog');
  const [entry, setEntry] = useState<McpCatalogEntry | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const entries = useMemo(() => catalog.data?.entries ?? [], [catalog.data]);

  function choose(next: McpCatalogEntry) {
    setEntry(next);
    setForm(formFor(next));
    setErrors({});
    setStep('form');
  }

  function close(next: boolean) {
    if (!next) {
      setStep('catalog');
      setEntry(null);
      setForm(EMPTY);
      setErrors({});
      setStarting(false);
    }
    onOpenChange(next);
  }

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function setHeader(index: number, patch: Partial<HeaderRow>) {
    setForm((previous) => ({
      ...previous,
      headers: previous.headers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = 'Enter a name.';
    if (!/^[a-z][a-z0-9]{1,15}$/.test(form.slug)) {
      found.slug = 'Use 2–16 lowercase letters and digits, starting with a letter.';
    }
    if (!form.url.trim()) found.url = 'Enter the server URL.';
    if (form.authType === 'headers' && form.headers.every((row) => !row.value.trim())) {
      found.headers = 'Add at least one header value.';
    }
    if (
      form.authType === 'oauth' &&
      form.registration === 'preregistered' &&
      (!form.clientId.trim() || !form.clientSecret.trim())
    ) {
      if (!form.clientId.trim()) found.clientId = 'Enter the OAuth client ID.';
      if (!form.clientSecret.trim()) found.clientSecret = 'Enter the OAuth client secret.';
    }
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    const headers: Record<string, string> = {};
    for (const row of form.headers) {
      if (!row.name.trim() || !row.value.trim()) continue;
      const prefix =
        entry?.auth.type === 'headers'
          ? (entry.auth.fields.find((field) => field.header === row.name)?.prefix ?? '')
          : '';
      headers[row.name.trim()] = `${prefix}${row.value.trim()}`;
    }
    const input: McpServerCreate = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      catalogId: form.catalogId,
      transport: form.transport,
      url: form.url.trim(),
      description: form.description.trim(),
      authType: form.authType,
      enabled: true,
      timeoutMs: Number(form.timeoutMs) || 10_000,
      maxResultChars: Number(form.maxResultChars) || 4000,
      ...(form.authType === 'headers' ? { headers } : {}),
      ...(form.authType === 'oauth'
        ? {
            oauthConfig: {
              registration: form.registration,
              ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
              ...(form.scopes.trim()
                ? {
                    scopes: form.scopes
                      .split(/[\s,]+/)
                      .map((scope) => scope.trim())
                      .filter(Boolean),
                  }
                : {}),
              ...(Object.keys(form.extraAuthParams).length > 0
                ? { extraAuthParams: form.extraAuthParams }
                : {}),
              ...(form.authorizationServer.trim()
                ? { authorizationServer: form.authorizationServer.trim() }
                : {}),
              sendResource: form.sendResource,
            },
            ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
          }
        : {}),
    };
    const oauthTab = form.authType === 'oauth' ? window.open('about:blank', '_blank') : null;
    if (oauthTab) oauthTab.opener = null;
    create.mutate(input, {
      onSuccess: async (created) => {
        if (created.authType === 'oauth') {
          setStarting(true);
          try {
            const started = await apiRequest<{ authorizationUrl: string }>(
              `/api/mcp/servers/${created.id}/oauth/start`,
              { method: 'POST' },
            );
            if (oauthTab && !oauthTab.closed) oauthTab.location.href = started.authorizationUrl;
            else window.open(started.authorizationUrl, '_blank', 'noopener,noreferrer');
            toast.success(`Added ${created.name}. Finish signing in in the new tab.`);
          } catch (error) {
            oauthTab?.close();
            toast.error(
              error instanceof Error ? `Added, but sign-in did not start: ${error.message}` : 'Added.',
            );
          }
        } else {
          toast.success(`Added ${created.name}.`);
        }
        close(false);
        if (created.authType === 'oauth') onCreated(created.id);
      },
      onError: (error) => {
        oauthTab?.close();
        if (isApiError(error)) {
          setErrors(error.fields);
          toast.error(error.fields._root ?? error.message);
        } else {
          toast.error(error.message);
        }
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-3xl">
        {step === 'catalog' ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a connector</DialogTitle>
              <DialogDescription>
                Pick a known service, or add any MCP server with “Custom”. You can change everything
                afterwards.
              </DialogDescription>
            </DialogHeader>
            <ul className="grid gap-2 sm:grid-cols-2">
              {entries.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => choose(item)}
                    className="flex h-full w-full flex-col gap-1 rounded-xl border bg-card p-3 text-left transition-colors hover:border-ring hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.label}</span>
                      <Badge variant="outline">{item.status}</Badge>
                    </span>
                    <span className="text-sm text-muted-foreground">{item.defaultDescription}</span>
                    <span className="mt-1 text-xs text-muted-foreground">{item.vendor}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Setup guides: <code>docs/connectors.md</code> in the repository. Google's MCP servers are in
              Developer Preview and need a Google Cloud OAuth client.
            </p>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="icon" onClick={() => setStep('catalog')}>
                  <ArrowLeftIcon aria-hidden="true" />
                  <span className="sr-only">Back to the catalog</span>
                </Button>
                {entry?.label ?? 'Custom MCP server'}
              </DialogTitle>
              <DialogDescription>{entry?.urlHint ?? entry?.url ?? 'The MCP endpoint URL.'}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="connector-name" error={errors.name}>
                <Input
                  id="connector-name"
                  value={form.name}
                  autoComplete="off"
                  aria-invalid={Boolean(errors.name) || undefined}
                  onChange={(event) => set('name', event.target.value)}
                />
              </Field>
              <Field
                label="Slug"
                htmlFor="connector-slug"
                error={errors.slug}
                help="Prefix of the tool names; cannot be changed later."
              >
                <Input
                  id="connector-slug"
                  value={form.slug}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.slug) || undefined}
                  onChange={(event) => set('slug', event.target.value)}
                />
              </Field>
            </div>

            <Field label="Server URL" htmlFor="connector-url" error={errors.url}>
              <Input
                id="connector-url"
                value={form.url}
                autoComplete="off"
                spellCheck={false}
                placeholder={entry?.urlHint ?? 'https://example.com/mcp'}
                aria-invalid={Boolean(errors.url) || undefined}
                onChange={(event) => set('url', event.target.value)}
              />
            </Field>

            <Field
              label="What it is (the model reads this)"
              htmlFor="connector-description"
              help="One line that says which account or place this is."
            >
              <Textarea
                id="connector-description"
                rows={2}
                maxLength={300}
                value={form.description}
                onChange={(event) => set('description', event.target.value)}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Transport" htmlFor="connector-transport">
                <select
                  id="connector-transport"
                  value={form.transport}
                  onChange={(event) => set('transport', event.target.value as Form['transport'])}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="streamable-http">Streamable HTTP (falls back to SSE)</option>
                  <option value="sse">HTTP + SSE (older servers)</option>
                </select>
              </Field>
              <Field label="Sign-in" htmlFor="connector-auth">
                <select
                  id="connector-auth"
                  value={form.authType}
                  onChange={(event) => set('authType', event.target.value as Form['authType'])}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="none">No sign-in</option>
                  <option value="headers">API key / headers</option>
                  <option value="oauth">OAuth sign-in</option>
                </select>
              </Field>
            </div>

            {form.authType === 'headers' && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Headers (write-only)</legend>
                {form.headers.map((row, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are position-based form inputs
                  <div key={`${row.name}-${index}`} className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      aria-label={`Header ${index + 1} name`}
                      value={row.name}
                      autoComplete="off"
                      spellCheck={false}
                      className="sm:max-w-56"
                      onChange={(event) => setHeader(index, { name: event.target.value })}
                    />
                    <Input
                      aria-label={`Header ${index + 1} value`}
                      value={row.value}
                      type="password"
                      autoComplete="new-password"
                      placeholder="Token or value"
                      onChange={(event) => setHeader(index, { value: event.target.value })}
                    />
                    {form.headers.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setForm((previous) => ({
                            ...previous,
                            headers: previous.headers.filter((_, i) => i !== index),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((previous) => ({
                      ...previous,
                      headers: [...previous.headers, { name: '', value: '' }],
                    }))
                  }
                >
                  <PlusIcon aria-hidden="true" /> Add header
                </Button>
                {errors.headers && <p className="text-sm text-destructive">{errors.headers}</p>}
              </fieldset>
            )}

            {form.authType === 'oauth' && (
              <fieldset className="space-y-3 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">OAuth</legend>
                <Field label="Client registration" htmlFor="connector-registration">
                  <select
                    id="connector-registration"
                    value={form.registration}
                    onChange={(event) => set('registration', event.target.value as Form['registration'])}
                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    <option value="auto">Automatic (dynamic registration)</option>
                    <option value="preregistered">I have a client ID and secret</option>
                  </select>
                </Field>
                {form.registration === 'preregistered' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Client ID" htmlFor="connector-client-id" error={errors.clientId}>
                      <Input
                        id="connector-client-id"
                        value={form.clientId}
                        autoComplete="off"
                        onChange={(event) => set('clientId', event.target.value)}
                      />
                    </Field>
                    <Field
                      label="Client secret"
                      htmlFor="connector-client-secret"
                      error={errors.clientSecret}
                      help="Write-only."
                    >
                      <Input
                        id="connector-client-secret"
                        type="password"
                        autoComplete="new-password"
                        value={form.clientSecret}
                        onChange={(event) => set('clientSecret', event.target.value)}
                      />
                    </Field>
                  </div>
                )}
                <Field
                  label="Scopes"
                  htmlFor="connector-scopes"
                  help="One per line. Leave empty to use what the server asks for."
                >
                  <Textarea
                    id="connector-scopes"
                    rows={3}
                    value={form.scopes}
                    onChange={(event) => set('scopes', event.target.value)}
                  />
                </Field>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
                  <div className="mt-3 space-y-3">
                    <Field
                      label="Authorization server"
                      htmlFor="connector-as"
                      help="Only when the server publishes no resource metadata."
                    >
                      <Input
                        id="connector-as"
                        value={form.authorizationServer}
                        placeholder="https://accounts.example.com"
                        onChange={(event) => set('authorizationServer', event.target.value)}
                      />
                    </Field>
                    <label
                      htmlFor="connector-send-resource"
                      className="flex items-center justify-between gap-3"
                    >
                      <span>Send the RFC 8707 resource parameter</span>
                      <Switch
                        id="connector-send-resource"
                        checked={form.sendResource}
                        onCheckedChange={(checked) => set('sendResource', checked)}
                      />
                    </label>
                  </div>
                </details>
              </fieldset>
            )}

            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Limits</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Tool timeout (ms)" htmlFor="connector-timeout">
                  <Input
                    id="connector-timeout"
                    type="number"
                    min={500}
                    max={20000}
                    value={form.timeoutMs}
                    onChange={(event) => set('timeoutMs', event.target.value)}
                  />
                </Field>
                <Field label="Maximum result (characters)" htmlFor="connector-result">
                  <Input
                    id="connector-result"
                    type="number"
                    min={500}
                    max={16000}
                    value={form.maxResultChars}
                    onChange={(event) => set('maxResultChars', event.target.value)}
                  />
                </Field>
              </div>
            </details>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || starting}>
                {create.isPending || starting
                  ? 'Saving…'
                  : form.authType === 'oauth'
                    ? 'Save and sign in'
                    : 'Save and connect'}
                {form.authType === 'oauth' && <ExternalLinkIcon aria-hidden="true" />}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  error,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  help?: string;
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
