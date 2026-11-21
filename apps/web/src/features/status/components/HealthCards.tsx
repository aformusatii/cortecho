import type { DeviceStatus, Health } from '@cortecho/shared';
import { ProblemFix } from '@/features/setup/components/ProblemFix.tsx';
import { CONNECTION_LABELS, formatTime, formatUptime, PROBLEM_LABELS } from '../format.ts';
import { StatusDot } from './StatusDot.tsx';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border bg-card p-4 shadow-xs">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      <div className="mt-2 space-y-1 text-sm">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}

const connectionTone = {
  connected: 'good',
  connecting: 'warn',
  disconnected: 'bad',
  disabled: 'off',
} as const;

function EchoCard({ device }: { device: DeviceStatus }) {
  return (
    <Card title={device.name}>
      <p className="text-base font-semibold">
        <StatusDot tone={connectionTone[device.state]}>{CONNECTION_LABELS[device.state]}</StatusDot>
      </p>
      {device.problem && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-destructive">{PROBLEM_LABELS[device.problem]}</p>
          <ProblemFix device={device} />
        </div>
      )}
      <Row label="Address">{`${device.host}:${device.port}`}</Row>
      <Row label="Link">{device.encryption === 'noise' ? 'Encrypted (API key)' : 'Plaintext'}</Row>
      <Row label="Name">{device.info?.friendlyName || device.info?.name || device.nodeName || '–'}</Row>
      <Row label="Doing">{device.pipeline.state}</Row>
      <Row label="Connected since">{device.connectedSince ? formatTime(device.connectedSince) : '–'}</Row>
      <Row label="Clock sent">{device.lastTimeSyncAt ? formatTime(device.lastTimeSyncAt) : '–'}</Row>
      <Row label="Reconnects">{device.reconnects}</Row>
      {device.overrideCount > 0 && <Row label="Own settings">{device.overrideCount}</Row>}
    </Card>
  );
}

const connectorTone = {
  connected: 'good',
  connecting: 'warn',
  needs_auth: 'warn',
  disabled: 'off',
  error: 'bad',
} as const;

export function HealthCards({ health }: { health: Health }) {
  const { devices, openai, connectors } = health;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {devices.length === 0 ? (
        <Card title="Echoes">
          <p className="text-muted-foreground">No Echo is configured yet.</p>
        </Card>
      ) : (
        devices.map((device) => <EchoCard key={device.id} device={device} />)
      )}
      {connectors.length > 0 && (
        <Card title="Connectors">
          {connectors.map((connector) => (
            <Row key={connector.slug} label={connector.slug}>
              <StatusDot tone={connectorTone[connector.state]}>
                {connector.state === 'connected'
                  ? 'Connected'
                  : connector.state === 'needs_auth'
                    ? 'Needs sign-in'
                    : connector.state}
              </StatusDot>
            </Row>
          ))}
        </Card>
      )}
      <Card title="Pipeline">
        <Row label="Uptime">{formatUptime(health.uptimeSeconds)}</Row>
        <Row label="Tools">{health.tools.length}</Row>
        <p className="pt-1 text-xs break-words text-muted-foreground">
          {health.tools.join(', ') || 'No tools'}
        </p>
      </Card>
      <Card title="OpenAI">
        <p className="text-base font-semibold">
          <StatusDot tone={openai.configured ? 'good' : 'bad'}>
            {openai.configured ? 'API key set' : 'OPENAI_API_KEY missing'}
          </StatusDot>
        </p>
        <Row label="Speech to text">{openai.sttModel}</Row>
        <Row label="Agent">{openai.agentModel}</Row>
        <Row label="Text to speech">{openai.ttsModel}</Row>
      </Card>
    </div>
  );
}
