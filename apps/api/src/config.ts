/**
 * The configuration that stays in the environment: deployment details, tool
 * permissions and debug paths. Every behaviour setting lives in the settings
 * registry and the database instead, and is read per turn (see
 * features/settings/). The Echoes themselves are rows in SQLite.
 */

import { readFileSync } from 'node:fs';

/**
 * Every environment name read here. The configuration drift test compares this
 * set with docs/configuration.md, so a new variable cannot stay undocumented.
 */
const readNames = new Set<string>();

function raw(name: string): string | undefined {
  readNames.add(name);
  return process.env[name];
}

/** The environment-only names read by `loadConfig()`. */
export function configEnvNames(): string[] {
  return [...readNames].sort();
}

function optionalStr(name: string): string | undefined {
  const value = raw(name)?.trim();
  return value ? value : undefined;
}

function int(name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const rawValue = raw(name);
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${rawValue}")`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = raw(name)?.trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function list(name: string): string[] {
  return (raw(name) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export type DiscoveryTargetConfig = { host: string; port: number };

/**
 * `host:port` entries, comma-separated. Extra targets cover Echos on another
 * subnet and the e2e/test FakeEchos; the scan itself only ever connects to
 * private IPv4 addresses.
 */
function targets(name: string): DiscoveryTargetConfig[] {
  return list(name).map((entry) => {
    const separator = entry.lastIndexOf(':');
    const host = separator > 0 ? entry.slice(0, separator).trim() : '';
    const port = separator > 0 ? Number(entry.slice(separator + 1)) : Number.NaN;
    if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${name}: "${entry}" is not host:port`);
    }
    return { host, port };
  });
}

/** `{"name": {...}}` JSON from an env var, or `{}`. */
function jsonObject<T>(name: string): Record<string, T> {
  const value = raw(name)?.trim();
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Record<string, T>;
  } catch (error) {
    throw new Error(`${name} must be a JSON object (${(error as Error).message})`);
  }
}

export type HttpToolEndpoint = { url: string; method?: 'GET' | 'POST'; description?: string };
export type ShellToolScript = { path: string; description?: string };

type ToolsFile = {
  httpToolEndpoints?: Record<string, HttpToolEndpoint>;
  shellToolScripts?: Record<string, ShellToolScript>;
};

/**
 * The file alternative for the JSON-in-an-env-var tool settings. A file is
 * easier to edit and cannot be broken by shell quoting.
 */
function toolsFile(name: string): ToolsFile {
  const file = optionalStr(name);
  if (!file) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${name}: could not read ${file} (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${name}: ${file} must contain a JSON object`);
  const value = parsed as ToolsFile;
  if (value.httpToolEndpoints && typeof value.httpToolEndpoints !== 'object')
    throw new Error(`${name}: httpToolEndpoints must be an object`);
  if (value.shellToolScripts && typeof value.shellToolScripts !== 'object')
    throw new Error(`${name}: shellToolScripts must be an object`);
  return value;
}

export function loadConfig() {
  const fromFile = toolsFile('TOOLS_FILE');
  return {
    discovery: {
      /** Env-only additions to the network scan: other subnets, e2e and tests. */
      extraTargets: targets('DISCOVERY_EXTRA_TARGETS'),
    },
    reply: {
      /**
       * Where the Echo downloads reply audio is the `network.replyBaseUrl`
       * setting now (imported once from REPLY_AUDIO_BASE_URL). Only the URL
       * lifetime stays in the environment.
       */
      /** A reply URL stops working after this long. */
      ttlMs: int('REPLY_AUDIO_TTL_MS', 120000, { min: 5000 }),
    },
    /** Not settings: a path on the server and how many recordings to keep. */
    debug: {
      audioDir: optionalStr('DEBUG_AUDIO_DIR'),
      audioKeep: int('DEBUG_AUDIO_KEEP', 20, { min: 1 }),
    },
    openai: {
      /** Only for tests / proxies; leave empty for api.openai.com. The key is a setting. */
      baseUrl: optionalStr('OPENAI_BASE_URL'),
    },
    tools: {
      /** Per-tool timeout. */
      timeoutMs: int('TOOL_TIMEOUT_MS', 8000, { min: 500 }),
      /** Names of destructive tools that may run. Everything else destructive is refused. */
      allowDestructive: list('TOOLS_ALLOW_DESTRUCTIVE'),
      /** Named HTTP endpoints for the http_request tool; the file wins over the env JSON. */
      httpEndpoints: {
        ...jsonObject<HttpToolEndpoint>('HTTP_TOOL_ENDPOINTS'),
        ...(fromFile.httpToolEndpoints ?? {}),
      },
      homeAssistant: {
        url: optionalStr('HOME_ASSISTANT_URL'),
        token: optionalStr('HOME_ASSISTANT_TOKEN'),
        /** Services the call-service tool may call, e.g. "light.turn_on,light.turn_off". */
        allowedServices: list('HOME_ASSISTANT_ALLOWED_SERVICES'),
      },
      /** Named scripts for the run_script tool; the file wins over the env JSON. */
      shellScripts: {
        ...jsonObject<ShellToolScript>('SHELL_TOOL_SCRIPTS'),
        ...(fromFile.shellToolScripts ?? {}),
      },
      enableEchoTool: bool('TOOLS_ENABLE_ECHO', true),
    },
    mcp: {
      /** The browser-facing URL for OAuth redirects. Empty = derive from the request origin. */
      publicBaseUrl: (optionalStr('PUBLIC_BASE_URL') ?? '').replace(/\/+$/, ''),
      /** AES-256-GCM key for connector secrets. Missing = no headers/OAuth connectors. */
      secretKey: optionalStr('CORTECHO_SECRET_KEY'),
      /** Extra browser origins allowed to call the connector write routes. */
      allowedOrigins: list('MCP_ALLOWED_ORIGINS'),
      /** Client ID Metadata Document support (needs the public path to be reachable). */
      cimdEnabled: bool('MCP_CIMD_ENABLED', false),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
