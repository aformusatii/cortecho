import type { Tool } from '../registry.ts';

/**
 * Home Assistant REST API (https://developers.home-assistant.io/docs/api/rest).
 * Registered only when HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN are set.
 *
 * NOTE: Home Assistant must not adopt the Echo while this app runs (hassmic
 * gives the voice assistant to one client, and HA would set its own API
 * key). Using HA's REST API from here is fine; it does not touch the Echo.
 */
type HaOptions = { url?: string; token?: string; allowedServices: string[] };

async function haFetch(options: Required<Pick<HaOptions, 'url' | 'token'>>, path: string, init: RequestInit) {
  const response = await fetch(new URL(path, options.url), {
    ...init,
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Home Assistant answered ${response.status}`);
  return response.json() as Promise<unknown>;
}

/** Read-only: the state of one entity. */
export function homeAssistantStateTool(options: HaOptions): Tool | null {
  const { url, token } = options;
  if (!url || !token) return null;
  return {
    name: 'home_assistant_get_state',
    description: 'Reads the current state of a Home Assistant entity, e.g. sensor.living_room_temperature.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string', description: 'Entity id, e.g. light.kitchen.' } },
      required: ['entity_id'],
      additionalProperties: false,
    },
    handler: async (args, { signal }) => {
      const entityId = String(args.entity_id ?? '');
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId))
        throw new Error('entity_id must look like domain.object_id');
      const state = (await haFetch({ url, token }, `/api/states/${entityId}`, { signal })) as {
        state?: unknown;
        attributes?: Record<string, unknown>;
      };
      return { entity_id: entityId, state: state.state, unit: state.attributes?.unit_of_measurement };
    },
  };
}

/**
 * Destructive: calls a service. Runs only when listed in
 * TOOLS_ALLOW_DESTRUCTIVE, and only for services in HOME_ASSISTANT_ALLOWED_SERVICES.
 */
export function homeAssistantServiceTool(options: HaOptions): Tool | null {
  const { url, token, allowedServices } = options;
  if (!url || !token || allowedServices.length === 0) return null;
  return {
    name: 'home_assistant_call_service',
    description: `Calls a Home Assistant service on one entity. Allowed services: ${allowedServices.join(', ')}.`,
    destructive: true,
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: allowedServices },
        entity_id: { type: 'string', description: 'Entity id, e.g. light.kitchen.' },
      },
      required: ['service', 'entity_id'],
      additionalProperties: false,
    },
    handler: async (args, { signal }) => {
      const service = String(args.service ?? '');
      const entityId = String(args.entity_id ?? '');
      if (!allowedServices.includes(service)) throw new Error(`service "${service}" is not allowed`);
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId))
        throw new Error('entity_id must look like domain.object_id');
      const [domain, name] = service.split('.');
      await haFetch({ url, token }, `/api/services/${domain}/${name}`, {
        method: 'POST',
        body: JSON.stringify({ entity_id: entityId }),
        signal,
      });
      return { ok: true, service, entity_id: entityId };
    },
  };
}
