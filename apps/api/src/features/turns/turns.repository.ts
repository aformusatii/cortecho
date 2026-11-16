import type { ToolCallRecord, Turn, TurnOutcome, TurnSource, TurnTimings } from '@cortecho/shared';
import { desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { devices, type TurnRow, turns } from '../../db/schema.ts';

/** Older rows are deleted so the table never grows without bound. */
const KEEP_TURNS = 1000;

export type NewTurn = import('@cortecho/shared').SearchDisplay & {
  source: TurnSource;
  outcome: TurnOutcome;
  startedAt: Date;
  /** The Echo the turn came from; absent for /api/ask without a device. */
  deviceId?: number | null;
  /** The settings version the turn ran with. */
  settingsVersion?: number | null;
  transcript?: string | null;
  reply?: string | null;
  toolCalls?: ToolCallRecord[];
  timings?: TurnTimings;
  error?: string | null;
};

/** A row plus the device name joined at read time, so a rename shows everywhere. */
type TurnWithDevice = { turn: TurnRow; deviceName: string | null };

function toTurn({ turn, deviceName }: TurnWithDevice): Turn {
  return {
    id: turn.id,
    source: turn.source,
    outcome: turn.outcome,
    startedAt: turn.startedAt,
    deviceId: turn.deviceId,
    deviceName,
    settingsVersion: turn.settingsVersion,
    transcript: turn.transcript,
    reply: turn.reply,
    ...(turn.searchDisplay ? JSON.parse(turn.searchDisplay) : {}),
    toolCalls: JSON.parse(turn.toolCalls) as ToolCallRecord[],
    timings: JSON.parse(turn.timings) as TurnTimings,
    error: turn.error,
  };
}

export function createTurnsRepository(db: Db) {
  return {
    insert(turn: NewTurn): Turn {
      const row = db
        .insert(turns)
        .values({
          source: turn.source,
          outcome: turn.outcome,
          startedAt: turn.startedAt.toISOString(),
          deviceId: turn.deviceId ?? null,
          settingsVersion: turn.settingsVersion ?? null,
          transcript: turn.transcript ?? null,
          reply: turn.reply ?? null,
          searchDisplay: turn.displayText
            ? JSON.stringify({ displayText: turn.displayText, citations: turn.citations ?? [] })
            : null,
          toolCalls: JSON.stringify(turn.toolCalls ?? []),
          timings: JSON.stringify(turn.timings ?? {}),
          error: turn.error ?? null,
        })
        .returning()
        .get();
      // Cheap: the id is the primary key.
      db.delete(turns)
        .where(lt(turns.id, row.id - KEEP_TURNS + 1))
        .run();
      const deviceName = row.deviceId === null ? null : deviceNameOf(db, row.deviceId);
      return toTurn({ turn: row, deviceName });
    },

    latest(limit: number, { deviceId }: { deviceId?: number } = {}): Turn[] {
      const query = db
        .select({ turn: turns, deviceName: devices.name })
        .from(turns)
        .leftJoin(devices, eq(turns.deviceId, devices.id))
        .orderBy(desc(turns.id))
        .limit(limit);
      const rows = deviceId === undefined ? query.all() : query.where(eq(turns.deviceId, deviceId)).all();
      return rows.map(toTurn);
    },
  };
}

function deviceNameOf(db: Db, id: number): string | null {
  return db.select({ name: devices.name }).from(devices).where(eq(devices.id, id)).get()?.name ?? null;
}

export type TurnsRepository = ReturnType<typeof createTurnsRepository>;
