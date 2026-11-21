import { discoveryIgnoreSchema, discoveryScanSchema } from '@cortecho/shared';
import { Hono } from 'hono';
import { normalizeMac } from '../../esphome/mac.ts';
import { validationError } from '../../lib/errors.ts';
import { validate } from '../../lib/validation.ts';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';

/**
 * Discovery API (spec §7.8). Read-only apart from the ignore list; a device
 * key is never part of a sighting, and no route opens a device connection.
 */
export function createDiscoveryRoutes(runtime: VoiceRuntime) {
  return (
    new Hono()
      .get('/discovery', (c) => c.json(runtime.discovery.document()))

      // 202 with the current document: the scan runs in the background, and a
      // call inside the 60 s window returns the running/last scan unchanged.
      .post('/discovery/scan', validate('json', discoveryScanSchema), (c) => {
        const { hints } = c.req.valid('json');
        return c.json(runtime.discovery.startScan(hints ?? []), 202);
      })

      .post('/discovery/ignore', validate('json', discoveryIgnoreSchema), (c) => {
        const mac = normalizeMac(c.req.valid('json').mac);
        if (!mac) throw validationError({ mac: "Enter the Echo's MAC address (12 hex digits)." });
        runtime.discovery.ignore(mac);
        return c.body(null, 204);
      })

      .delete('/discovery/ignore/:mac', (c) => {
        const mac = normalizeMac(c.req.param('mac'));
        if (!mac) throw validationError({ mac: "Enter the Echo's MAC address (12 hex digits)." });
        runtime.discovery.unignore(mac);
        return c.body(null, 204);
      })
  );
}
