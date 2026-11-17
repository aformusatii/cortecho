/**
 * A tiny leveled logger: one line per message, ISO timestamp, component tag.
 * Docker collects stdout/stderr, so there is no file handling here.
 *
 * Never pass secrets (API keys, tokens) or raw audio to it.
 */

const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LEVELS)[number];

function readLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info')).toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : 'info';
}

let threshold = LEVELS.indexOf(readLevel());

/** Tests and scripts can change the level at runtime. */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS.indexOf(level);
}

export type Logger = {
  debug: (message: string, extra?: Record<string, unknown>) => void;
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
};

function write(
  level: Exclude<LogLevel, 'silent'>,
  component: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  if (LEVELS.indexOf(level) < threshold) return;
  const safeExtra = extra === undefined ? undefined : (redactValue(extra) as Record<string, unknown>);
  const suffix = safeExtra && Object.keys(safeExtra).length > 0 ? ` ${JSON.stringify(safeExtra)}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}] ${redactText(message)}${suffix}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

/** Keys whose values must never reach a log line (OAuth, headers, API keys). */
const SECRET_KEY =
  /authorization|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|api[-_]?key|password|secret/i;

/** Recursively replaces secret-named values; also used by the redaction test. */
export function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactValue(item, name)]),
    );
  }
  return typeof value === 'string' ? redactText(value) : value;
}

/** Removes OAuth codes/states/tokens from free text (URLs and error messages). */
export function redactText(text: string): string {
  return text.replace(
    /\b(code|state|access_token|refresh_token|id_token|client_secret|api_key)=([^&\s"']+)/gi,
    '$1=[redacted]',
  );
}

export function createLogger(component: string): Logger {
  return {
    debug: (message, extra) => write('debug', component, message, extra),
    info: (message, extra) => write('info', component, message, extra),
    warn: (message, extra) => write('warn', component, message, extra),
    error: (message, extra) => write('error', component, message, extra),
  };
}

/** Error message without the stack, for log lines and turn records. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
