import type { McpCatalogEntry } from './mcp.schema.ts';

/**
 * The connector catalog. Adding support for a service is one entry here (plus
 * a guide section), never new code: the Add dialog renders the cards and the
 * form from these descriptors. "Custom" always works for any other server.
 *
 * URLs and scopes were checked on 2026-11-17 against the MCP connector spec
 * (specs/mcp-connectors.md §9/§16). Google's servers are in Developer
 * Preview; the self-hosted entry is the fallback for personal accounts.
 */
export const CONNECTOR_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: 'google-gmail',
    label: 'Gmail',
    vendor: 'Google',
    status: 'preview',
    suggestedSlug: 'gmail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'streamable-http',
    auth: {
      type: 'oauth',
      registration: 'preregistered',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ],
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    defaultDescription: "The owner's personal mailbox (read, search, drafts; no sending).",
    guideAnchor: 'gmail',
  },
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    vendor: 'Google',
    status: 'preview',
    suggestedSlug: 'calendar',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    transport: 'streamable-http',
    auth: {
      type: 'oauth',
      registration: 'preregistered',
      scopes: [
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ],
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    defaultDescription: "The family's calendar: events, availability and appointments.",
    guideAnchor: 'google-calendar',
  },
  {
    id: 'google-drive',
    label: 'Google Drive',
    vendor: 'Google',
    status: 'preview',
    suggestedSlug: 'drive',
    urlHint: 'https://drivemcp.googleapis.com/mcp/v1 (verify in Google Cloud)',
    transport: 'streamable-http',
    auth: {
      type: 'oauth',
      registration: 'preregistered',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    defaultDescription: "The owner's Google Drive files (read-only).",
    guideAnchor: 'google-drive',
  },
  {
    id: 'google-workspace-selfhosted',
    label: 'Google Workspace (self-hosted)',
    vendor: 'Community',
    status: 'community',
    suggestedSlug: 'workspace',
    urlHint: 'http://192.168.100.x:8080/mcp',
    transport: 'streamable-http',
    auth: { type: 'oauth', registration: 'auto' },
    defaultDescription: "The household's Gmail and Calendar through the self-hosted workspace-mcp server.",
    guideAnchor: 'workspace-selfhosted',
  },
  {
    id: 'home-assistant',
    label: 'Home Assistant',
    vendor: 'Home Assistant',
    status: 'community',
    suggestedSlug: 'ha',
    urlHint: 'http://192.168.100.x:8123/api/mcp',
    transport: 'streamable-http',
    auth: {
      type: 'headers',
      fields: [{ header: 'Authorization', label: 'Long-lived access token', prefix: 'Bearer ' }],
    },
    defaultDescription: 'The home: lights, switches, climate, covers and scenes.',
    guideAnchor: 'home-assistant',
  },
  {
    id: 'custom',
    label: 'Custom MCP server',
    vendor: 'Any',
    status: 'stable',
    suggestedSlug: 'custom',
    urlHint: 'https://example.com/mcp or http://192.168.100.x:3000/mcp',
    transport: 'streamable-http',
    auth: { type: 'none' },
    defaultDescription: 'A connected service the owner added.',
    guideAnchor: 'custom',
  },
] as const;

export const CONNECTOR_CATALOG_BY_ID: ReadonlyMap<string, McpCatalogEntry> = new Map(
  CONNECTOR_CATALOG.map((entry) => [entry.id, entry]),
);

export function catalogEntry(id: string | null | undefined): McpCatalogEntry | undefined {
  return id ? CONNECTOR_CATALOG_BY_ID.get(id) : undefined;
}
