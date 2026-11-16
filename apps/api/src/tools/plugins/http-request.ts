import type { HttpToolEndpoint } from '../../config.ts';
import type { Tool } from '../registry.ts';

const MAX_BODY_CHARS = 2000;

/**
 * Calls one of a fixed set of HTTP endpoints from HTTP_TOOL_ENDPOINTS, e.g.
 *   {"weather":{"url":"http://192.168.1.10:8006/weather","description":"Current outdoor weather"}}
 * The model picks an endpoint by NAME only; it can never choose a URL, so it
 * cannot be talked into fetching arbitrary addresses. POST endpoints count
 * as destructive (they usually trigger something).
 */
export function httpRequestTool(endpoints: Record<string, HttpToolEndpoint>): Tool | null {
  const names = Object.keys(endpoints);
  if (names.length === 0) return null;
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (typeof endpoint?.url !== 'string' || !/^https?:\/\//.test(endpoint.url)) {
      throw new Error(`HTTP_TOOL_ENDPOINTS.${name}.url must be an http(s) URL`);
    }
  }
  const catalogue = names
    .map((name) => `${name}${endpoints[name]?.description ? ` (${endpoints[name]?.description})` : ''}`)
    .join('; ');
  const destructive = names.some((name) => (endpoints[name]?.method ?? 'GET') !== 'GET');

  return {
    name: 'http_request',
    description: `Fetches data from or triggers a configured home endpoint. Available endpoints: ${catalogue}.`,
    destructive,
    parameters: {
      type: 'object',
      properties: { endpoint: { type: 'string', enum: names, description: 'Which endpoint to call.' } },
      required: ['endpoint'],
      additionalProperties: false,
    },
    handler: async (args, { signal }) => {
      const endpoint = endpoints[String(args.endpoint)];
      if (!endpoint) throw new Error(`unknown endpoint "${String(args.endpoint)}"`);
      const response = await fetch(endpoint.url, { method: endpoint.method ?? 'GET', signal });
      const body = (await response.text()).slice(0, MAX_BODY_CHARS);
      return { status: response.status, body };
    },
  };
}
