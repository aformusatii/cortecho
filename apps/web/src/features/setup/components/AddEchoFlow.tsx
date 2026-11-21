import type { DeviceStatus, DiscoveredEcho, Turn } from '@cortecho/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  useAdoptEcho,
  useProbeEcho,
  useTestSound,
  useUpdateDevice,
} from '@/features/devices/api/devices.mutations.ts';
import { devicesQueryOptions, deviceTurnsQueryOptions } from '@/features/devices/api/devices.queries.ts';
import { useSaveSettings } from '@/features/settings/api/settings.mutations.ts';
import { settingsQueryOptions } from '@/features/settings/api/settings.queries.ts';
import { isApiError } from '@/lib/api-client.ts';
import { useScanDiscovery, useScanOnOpen, useUnignoreEcho } from '../api/discovery.mutations.ts';
import { discoveryQueryOptions } from '../api/discovery.queries.ts';
import {
  type FlowProblem,
  type FlowState,
  type FlowTarget,
  problemDetail,
  replyAddressPrefill,
} from '../flow.ts';
import { ChooseStep } from '../steps/ChooseStep.tsx';
import { ConfirmStep } from '../steps/ConfirmStep.tsx';
import { DoneStep } from '../steps/DoneStep.tsx';
import { IdentifyStep } from '../steps/IdentifyStep.tsx';
import { NameStep } from '../steps/NameStep.tsx';
import { type TryPhase, TryStep } from '../steps/TryStep.tsx';

/** The window between a ticked checklist and the next step (spec §5.2). */
const ADVANCE_AFTER_ADOPT_MS = 600;
/** How long Step 5 waits before it offers to skip (spec §5.2). */
const TRY_HINT_AFTER_MS = 60_000;
/** How long the heard turn stays on screen before Step 6. */
const ADVANCE_AFTER_HEARD_MS = 1500;

type AddEchoFlowProps = {
  /** A Discovered card's Add: the flow opens at Step 2 with that Echo. */
  initialTarget?: DiscoveredEcho | null;
  /** Called as soon as the Echo exists, before Step 3. */
  onAdopted?: (device: DeviceStatus) => void;
  /** Step 6's primary button; when absent the flow simply stays on Done. */
  onDone?: (device: DeviceStatus) => void;
  doneLabel?: string;
};

/**
 * The Add Echo flow (spec §5.2), one component in two shells: a section of
 * `/setup` and a dialog on `/echos`. It owns every step and every branch; the
 * shells only give it a place and handle Done.
 */
export function AddEchoFlow({ initialTarget, onAdopted, onDone, doneLabel = 'Done' }: AddEchoFlowProps) {
  const [state, setState] = useState<FlowState>(() => initialState(initialTarget));
  const [pending, setPending] = useState(false);
  const [namePending, setNamePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);

  const discovery = useQuery(discoveryQueryOptions());
  const settings = useQuery(settingsQueryOptions());
  const activeDeviceId = 'deviceId' in state ? state.deviceId : 0;
  const devices = useQuery(devicesQueryOptions(state.step === 'choose' ? 5000 : 1000));
  const turns = useQuery({
    ...deviceTurnsQueryOptions(activeDeviceId, 1, state.step === 'try' ? 1000 : 5000),
    enabled: activeDeviceId > 0 && state.step !== 'choose' && state.step !== 'confirm',
  });

  const adopt = useAdoptEcho();
  const probe = useProbeEcho();
  const sound = useTestSound();
  const update = useUpdateDevice(activeDeviceId);
  const saveSettings = useSaveSettings();
  const unignore = useUnignoreEcho();
  const scan = useScanDiscovery();
  const navigate = useNavigate();

  useScanOnOpen();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Focus the new step's heading (spec §5.7). requestAnimationFrame lets a
  // dialog finish its own focus handling first.
  const focusKey = state.step === 'confirm' ? `confirm:${state.mode}` : state.step;
  useEffect(() => {
    if (!focusKey) return;
    const frame = requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>('[data-flow-heading]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  // Step 5 needs a clock for the 60 s hint; polling alone does not re-render.
  useEffect(() => {
    if (state.step !== 'try') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [state.step]);

  const replyBaseUrl = stringSetting(settings.data?.effective['network.replyBaseUrl']);
  const settingPrefill = replyAddressPrefill(replyBaseUrl, window.location.origin);

  async function writeReplyAddress(value: string): Promise<void> {
    const document = settings.data;
    if (!document) throw new Error('The settings are still loading.');
    const changes = { 'network.replyBaseUrl': value };
    try {
      await saveSettings.mutateAsync({ version: document.version, changes });
    } catch (error) {
      // Another tab saved first: take its version and write once more.
      if (!isApiError(error) || error.status !== 409) throw error;
      const next = await settings.refetch();
      const version = next.data?.version;
      if (version === undefined) throw error;
      await saveSettings.mutateAsync({ version, changes });
    }
  }

  /** First Echo with no reply address: save the browser origin before playing. */
  async function maybeSaveReplyAddress(): Promise<void> {
    if (!settings.data || replyBaseUrl.trim() !== '' || settingPrefill === '') return;
    try {
      await writeReplyAddress(settingPrefill);
    } catch {
      // The chime will not download; Step 3 then asks for the address.
    }
  }

  function setIdentify(deviceId: number, patch: Partial<Extract<FlowState, { step: 'identify' }>>): void {
    setState((previous) =>
      previous.step === 'identify' && previous.deviceId === deviceId ? { ...previous, ...patch } : previous,
    );
  }

  async function playSound(deviceId: number, silentPrefill = false): Promise<void> {
    setIdentify(deviceId, { status: 'playing', soundError: null, notConfirmed: false });
    try {
      if (silentPrefill) await maybeSaveReplyAddress();
      const result = await sound.mutateAsync(deviceId);
      if (!result.downloaded) {
        setIdentify(deviceId, {
          status: 'address',
          address: replyAddressPrefill(replyBaseUrl, window.location.origin),
          addressError: null,
        });
        return;
      }
      setIdentify(deviceId, { status: 'asking', notConfirmed: !result.finished });
    } catch (error) {
      const notReady = isApiError(error) && (error.code === 'ECHO_UNAVAILABLE' || error.code === 'ECHO_BUSY');
      setIdentify(deviceId, {
        status: 'playing',
        soundError: notReady ? 'The Echo is not ready yet.' : errorMessage(error),
      });
    }
  }

  // Step 3 begins as soon as the link is up (adopt may return early).
  const identifyDevice =
    state.step === 'identify' ? devices.data?.find((device) => device.id === state.deviceId) : undefined;
  const identifyConnected = identifyDevice?.state === 'connected';
  const autoPlayed = useRef<number | null>(null);
  useEffect(() => {
    if (state.step !== 'identify' || state.status !== 'connecting' || !identifyConnected) return;
    if (autoPlayed.current === state.deviceId) return;
    autoPlayed.current = state.deviceId;
    void playSound(state.deviceId, true);
  });

  function enterIdentify(deviceId: number): void {
    autoPlayed.current = null;
    setState({
      step: 'identify',
      deviceId,
      status: 'connecting',
      address: '',
      addressError: null,
      soundError: null,
      notConfirmed: false,
    });
  }

  async function adoptTarget(target: FlowTarget, apiKey?: string): Promise<void> {
    setState({ step: 'confirm', target, mode: 'adopting', key: '', keyError: null, problem: null });
    try {
      const device = await adopt.mutateAsync({
        host: target.host,
        port: target.port,
        kind: target.kind,
        ...(apiKey ? { apiKey } : {}),
      });
      onAdopted?.(device);
      setState({ step: 'confirm', target, mode: 'adopted', key: '', keyError: null, problem: null });
      await new Promise((resolve) => setTimeout(resolve, ADVANCE_AFTER_ADOPT_MS));
      if (!mounted.current) return;
      if (target.kind === 'test') {
        setState({ step: 'name', deviceId: device.id, value: '', error: null });
      } else {
        enterIdentify(device.id);
      }
    } catch (error) {
      if (!mounted.current) return;
      if (isApiError(error) && error.code === 'ECHO_KEY_SET') {
        setState({ step: 'confirm', target, mode: 'needs-key', key: '', keyError: null, problem: null });
        return;
      }
      if (isApiError(error) && error.code === 'ECHO_KEY_INVALID') {
        setState({
          step: 'confirm',
          target,
          mode: 'needs-key',
          key: apiKey ?? '',
          keyError: error.fields.apiKey ?? error.message,
          problem: null,
        });
        return;
      }
      setState({
        step: 'confirm',
        target,
        mode: 'problem',
        key: '',
        keyError: null,
        problem: problemFor(error),
      });
    }
  }

  async function chooseNext(): Promise<void> {
    if (state.step !== 'choose') return;

    if (!state.manual) {
      const echo = (discovery.data?.found ?? []).find((entry) => entry.mac === state.selectedMac);
      if (!echo || echo.addedAs) return;
      setState({
        step: 'confirm',
        target: {
          host: echo.host,
          port: echo.port,
          kind: 'echo',
          discovered: echo,
          label: echo.friendlyName,
        },
        mode: 'ready',
        key: '',
        keyError: null,
        problem: null,
      });
      return;
    }

    const host = state.host.trim();
    const port = Number(state.port);
    const errors: Record<string, string> = {};
    if (host === '') errors.host = 'Enter an address.';
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.port = 'Use a port between 1 and 65535.';
    }
    if (Object.keys(errors).length > 0) {
      setState({ ...state, errors });
      return;
    }

    setState({ ...state, errors: {} });
    setPending(true);
    try {
      const result = await probe.mutateAsync({ host, port });
      if (!result.reachable) {
        setState({
          step: 'confirm',
          target: { host, port, kind: state.kind, discovered: null, label: host },
          mode: 'problem',
          key: '',
          keyError: null,
          problem:
            result.code === 'not-esphome'
              ? {
                  kind: 'not-an-echo',
                  message: 'The device at this address does not offer a voice assistant.',
                }
              : { kind: 'unreachable', message: `Nothing answered at ${host}.` },
        });
        return;
      }
      const target: FlowTarget = {
        host,
        port,
        kind: state.kind,
        discovered: null,
        label: result.friendlyName || result.nodeName || host,
      };
      if (result.isVoiceAssistant === false) {
        setState({
          step: 'confirm',
          target,
          mode: 'problem',
          key: '',
          keyError: null,
          problem: {
            kind: 'not-an-echo',
            message: 'The device at this address does not offer a voice assistant.',
          },
        });
        return;
      }
      setState({
        step: 'confirm',
        target,
        // A keyed Echo needs its key pasted; adopt would say so too, but the
        // probe already knows and the spec asks this screen here.
        mode: result.keyState === 'set' ? 'needs-key' : 'ready',
        key: '',
        keyError: null,
        problem: null,
      });
    } catch (error) {
      if (isApiError(error) && error.code === 'ALREADY_ADDED') {
        setState({
          step: 'confirm',
          target: { host, port, kind: state.kind, discovered: null, label: host },
          mode: 'problem',
          key: '',
          keyError: null,
          problem: {
            kind: 'already-added',
            message: error.message,
            deviceId: numberField(error.fields.deviceId),
            name: error.fields.name,
          },
        });
        return;
      }
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        setState({ ...state, errors: error.fields });
        return;
      }
      setState({
        step: 'confirm',
        target: { host, port, kind: state.kind, discovered: null, label: host },
        mode: 'problem',
        key: '',
        keyError: null,
        problem: problemFor(error),
      });
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function submitName(): Promise<void> {
    if (state.step !== 'name') return;
    const value = state.value.trim();
    if (value === '') {
      setState({ ...state, error: 'Enter a name.' });
      return;
    }
    setNamePending(true);
    try {
      await update.mutateAsync({ name: value });
      if (!mounted.current) return;
      setState({ step: 'try', deviceId: state.deviceId, startedAt: Date.now() });
    } catch (error) {
      if (!mounted.current) return;
      const message = isApiError(error) ? (error.fields.name ?? error.message) : errorMessage(error);
      setState((previous) => (previous.step === 'name' ? { ...previous, error: message } : previous));
    } finally {
      if (mounted.current) setNamePending(false);
    }
  }

  async function saveAddressAndPlay(): Promise<void> {
    if (state.step !== 'identify') return;
    const deviceId = state.deviceId;
    try {
      await writeReplyAddress(state.address.trim());
    } catch (error) {
      const message = isApiError(error)
        ? (error.fields['network.replyBaseUrl'] ?? error.fields._root ?? error.message)
        : errorMessage(error);
      setIdentify(deviceId, { addressError: message });
      return;
    }
    void playSound(deviceId);
  }

  // Step 5: a turn that starts after the step opened is "heard".
  const baselineTurn = useRef<number | null>(null);
  useEffect(() => {
    if (state.step !== 'try') {
      baselineTurn.current = null;
      return;
    }
    if (baselineTurn.current !== null || !turns.isSuccess) return;
    baselineTurn.current = turns.data?.[0]?.id ?? 0;
  }, [state.step, turns.isSuccess, turns.data]);

  const tryDevice =
    state.step === 'try' ? devices.data?.find((device) => device.id === state.deviceId) : undefined;
  const heardTurn = latestHeard(turns.data, state.step === 'try' ? baselineTurn.current : null);
  const tryPhase: TryPhase =
    state.step !== 'try'
      ? 'waiting'
      : heardTurn
        ? 'heard'
        : tryDevice?.pipeline.state === 'listening'
          ? 'listening'
          : tryDevice?.pipeline.state === 'thinking' || tryDevice?.pipeline.state === 'speaking'
            ? 'thinking'
            : baselineTurn.current !== null && now - state.startedAt > TRY_HINT_AFTER_MS
              ? 'nothing'
              : 'waiting';

  useEffect(() => {
    if (state.step !== 'try' || tryPhase !== 'heard') return;
    const timer = setTimeout(() => {
      setState((previous) =>
        previous.step === 'try' ? { step: 'done', deviceId: previous.deviceId } : previous,
      );
    }, ADVANCE_AFTER_HEARD_MS);
    return () => clearTimeout(timer);
  }, [state.step, tryPhase]);

  const doneDevice =
    state.step === 'done' ? devices.data?.find((device) => device.id === state.deviceId) : undefined;
  const otherDevice =
    state.step === 'done'
      ? ((devices.data ?? []).find((device) => device.id !== state.deviceId) ?? null)
      : null;
  const namePlaceholder =
    state.step === 'name'
      ? (devices.data?.find((device) => device.id === state.deviceId)?.info?.friendlyName ?? '')
      : '';

  return (
    <div ref={containerRef} className="space-y-4">
      {state.step === 'choose' && (
        <ChooseStep
          state={state}
          found={discovery.data?.found ?? []}
          scanning={discovery.data?.scanning ?? false}
          pending={pending}
          onSelect={(mac) =>
            setState((previous) =>
              previous.step === 'choose' ? { ...previous, selectedMac: mac } : previous,
            )
          }
          onNext={() => void chooseNext()}
          onScanAgain={() => scan.mutate()}
          onManualChange={(manual) =>
            setState((previous) =>
              previous.step === 'choose' ? { ...previous, manual, errors: {} } : previous,
            )
          }
          onAdvancedChange={(advanced) =>
            setState((previous) => (previous.step === 'choose' ? { ...previous, advanced } : previous))
          }
          onShowIgnored={(showIgnored) =>
            setState((previous) => (previous.step === 'choose' ? { ...previous, showIgnored } : previous))
          }
          onField={(key, value) =>
            setState((previous) =>
              previous.step === 'choose'
                ? {
                    ...previous,
                    [key]: value,
                    errors: Object.fromEntries(
                      Object.entries(previous.errors).filter(([field]) => field !== key),
                    ),
                  }
                : previous,
            )
          }
          onUnignore={(mac) => unignore.mutate(mac)}
        />
      )}

      {state.step === 'confirm' && (
        <ConfirmStep
          state={state}
          onAdd={() => void adoptTarget(state.target)}
          onUseKey={() => void adoptTarget(state.target, state.key.trim())}
          onKeyChange={(key) =>
            setState((previous) => (previous.step === 'confirm' ? { ...previous, key } : previous))
          }
          onBack={() => backToChoose(state.target)}
          onTryAgain={() => void adoptTarget(state.target, state.key.trim() || undefined)}
          onChangeAddress={() => backToChoose(state.target)}
          onOpenDevice={(id) =>
            void navigate({ to: '/echos/$id', params: { id: String(id) }, search: { tab: 'overview' } })
          }
        />
      )}

      {state.step === 'identify' && (
        <IdentifyStep
          state={state}
          suggested={replyBaseUrl.trim() === '' && state.address !== '' && state.address === settingPrefill}
          onYes={() => setState({ step: 'name', deviceId: state.deviceId, value: '', error: null })}
          onNo={() => setIdentify(state.deviceId, { status: 'quiet', soundError: null })}
          onPlayAgain={() => void playSound(state.deviceId)}
          onAddressChange={(address) => setIdentify(state.deviceId, { address, addressError: null })}
          onSaveAddress={() => void saveAddressAndPlay()}
        />
      )}

      {state.step === 'name' && (
        <NameStep
          state={state}
          placeholder={namePlaceholder}
          pending={namePending}
          onChange={(value) =>
            setState((previous) =>
              previous.step === 'name' ? { ...previous, value, error: null } : previous,
            )
          }
          onSubmit={() => void submitName()}
          onBack={() => enterIdentify(state.deviceId)}
        />
      )}

      {state.step === 'try' && (
        <TryStep
          phase={tryPhase}
          transcript={heardTurn?.transcript ?? null}
          seconds={heardSeconds(heardTurn)}
          onSkip={() => setState({ step: 'done', deviceId: state.deviceId })}
        />
      )}

      {state.step === 'done' &&
        (doneDevice ? (
          <DoneStep
            device={doneDevice}
            other={otherDevice}
            doneLabel={doneLabel}
            onDone={() => onDone?.(doneDevice)}
            onOpen={() =>
              void navigate({
                to: '/echos/$id',
                params: { id: String(doneDevice.id) },
                search: { tab: 'connection' },
              })
            }
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Saving the Echo…
          </p>
        ))}
    </div>
  );

  function backToChoose(target: FlowTarget): void {
    setState({
      step: 'choose',
      manual: target.discovered === null,
      advanced: target.discovered === null,
      host: target.host,
      port: String(target.port),
      kind: target.kind,
      selectedMac: target.discovered?.mac ?? null,
      showIgnored: false,
      errors: {},
    });
  }
}

function initialState(initialTarget?: DiscoveredEcho | null): FlowState {
  if (initialTarget) {
    return {
      step: 'confirm',
      target: {
        host: initialTarget.host,
        port: initialTarget.port,
        kind: 'echo',
        discovered: initialTarget,
        label: initialTarget.friendlyName,
      },
      mode: 'ready',
      key: '',
      keyError: null,
      problem: null,
    };
  }
  return {
    step: 'choose',
    manual: false,
    advanced: false,
    host: '',
    port: '26053',
    kind: 'echo',
    selectedMac: null,
    showIgnored: false,
    errors: {},
  };
}

/** The adopt/probe error as the screen's branch (spec §5.2's table). */
function problemFor(error: unknown): FlowProblem {
  if (!isApiError(error)) return { kind: 'failed', message: errorMessage(error) };
  const detail = problemDetail(error.code, error.message);
  switch (error.code) {
    case 'ECHO_UNREACHABLE':
      return { kind: 'unreachable', message: error.message };
    case 'NOT_AN_ECHO':
      return { kind: 'not-an-echo', message: error.message };
    case 'ALREADY_ADDED':
      return {
        kind: 'already-added',
        message: error.message,
        deviceId: numberField(error.fields.deviceId),
        name: error.fields.name,
      };
    default:
      return { kind: 'failed', message: error.message, detail };
  }
}

function latestHeard(turns: readonly Turn[] | undefined, baseline: number | null): Turn | null {
  if (baseline === null) return null;
  const latest = turns?.[0];
  return latest && latest.id > baseline ? latest : null;
}

function heardSeconds(turn: Turn | null): number | null {
  if (!turn) return null;
  const ms = turn.timings.firstAudioMs ?? turn.timings.audioDoneMs;
  return typeof ms === 'number' ? ms / 1000 : null;
}

function stringSetting(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberField(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
