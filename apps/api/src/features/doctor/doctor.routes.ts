import type { DoctorReport } from '@cortecho/shared';
import { Hono } from 'hono';
import type { VoiceRuntime } from '../voice/voice-runtime.ts';

/** How long a report is reused, so a polling page cannot hammer the probes. */
const CACHE_MS = 15_000;

export function createDoctorRoutes(runtime: VoiceRuntime) {
  let cached: { at: number; report: DoctorReport } | null = null;
  return new Hono().get('/doctor', async (c) => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      cached = { at: Date.now(), report: await runtime.doctor() };
    }
    return c.json(cached.report);
  });
}
