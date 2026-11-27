import type {
  DeviceSettingsDocument,
  DeviceStatus,
  Health,
  SayResponse,
  SettingsDocument,
  Turn,
  VoiceSampleRequest,
} from '@cortecho/shared';

/**
 * The production Cortecho REST API (SMOKE_CORTECHO_URL), typed fetch helpers
 * for the harness. Failures throw SmokeApiError with the status and body.
 */
export class SmokeApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`Cortecho API ${status}: ${JSON.stringify(body)}`);
    this.name = 'SmokeApiError';
    this.status = status;
    this.body = body;
  }
}

export type DeviceCreate = {
  name: string;
  kind: 'echo';
  host: string;
  port: number;
  apiKey: string;
  enabled: boolean;
};

export class CortechoApi {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      const body = await response.text();
      throw new SmokeApiError(response.status, body);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private json(body: unknown): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  health(): Promise<Health> {
    return this.request<Health>('/api/health');
  }

  /** The global settings document: version and hasKeys, never a secret value. */
  settings(): Promise<SettingsDocument> {
    return this.request<SettingsDocument>('/api/settings');
  }

  /** POST /api/settings/voice-sample: the draft voice as a WAV, no Echo involved. */
  async voiceSample(input: VoiceSampleRequest): Promise<Buffer> {
    const response = await fetch(`${this.baseUrl}/api/settings/voice-sample`, this.json(input));
    if (!response.ok) throw new SmokeApiError(response.status, await response.text());
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('audio/')) {
      throw new Error(`voice-sample returned ${type || 'no content type'}, expected audio`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  listDevices(): Promise<DeviceStatus[]> {
    return this.request<DeviceStatus[]>('/api/devices');
  }

  createDevice(input: DeviceCreate): Promise<DeviceStatus> {
    return this.request<DeviceStatus>('/api/devices', this.json(input));
  }

  patchDevice(id: number, patch: Record<string, unknown>): Promise<DeviceStatus> {
    return this.request<DeviceStatus>(`/api/devices/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  deviceSettings(id: number): Promise<DeviceSettingsDocument> {
    return this.request<DeviceSettingsDocument>(`/api/devices/${id}/settings`);
  }

  patchDeviceSettings(
    id: number,
    patch: { version: number; changes: Record<string, unknown> },
  ): Promise<DeviceSettingsDocument> {
    return this.request<DeviceSettingsDocument>(`/api/devices/${id}/settings`, {
      ...this.json(patch),
      method: 'PATCH',
    });
  }

  /** Forget one Echo's conversation (idempotent). */
  resetConversation(id: number): Promise<void> {
    return this.request<void>(`/api/devices/${id}/conversation/reset`, { method: 'POST' });
  }

  /** Forget the web session. */
  resetWebConversation(): Promise<void> {
    return this.request<void>('/api/conversation/reset', { method: 'POST' });
  }

  turns(deviceId: number, limit = 20): Promise<Turn[]> {
    return this.request<Turn[]>(`/api/turns?limit=${limit}&deviceId=${deviceId}`);
  }

  say(text: string, { deviceId, all }: { deviceId?: number; all?: boolean } = {}): Promise<SayResponse> {
    const body: Record<string, unknown> = { text };
    if (deviceId !== undefined) body.deviceId = deviceId;
    if (all) body.all = true;
    return this.request<SayResponse>('/api/say', this.json(body));
  }
}
