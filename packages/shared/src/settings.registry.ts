import { z } from 'zod';

// ---------------------------------------------------------------------------
// The single description of every setting: the API validates with it and the
// web UI renders its forms from it. A new setting means one descriptor here
// plus the code that reads it (see AGENTS.md "New setting").
//
// Values are flat ('tts.voice'); buildSettings() turns a resolved map into the
// nested Settings object the API uses.
// ---------------------------------------------------------------------------

export const SETTING_SECTIONS = [
  'assistant',
  'understanding',
  'thinking',
  'voice',
  'conversation',
  'listening',
  'timing',
  'advanced',
] as const;
export type SectionId = (typeof SETTING_SECTIONS)[number];

export const SETTINGS_SECTION_LABELS: Record<SectionId, string> = {
  assistant: 'Assistant',
  understanding: 'Understanding',
  thinking: 'Thinking',
  voice: 'Voice',
  conversation: 'Conversation',
  listening: 'Listening',
  timing: 'Timing',
  advanced: 'Advanced',
};

export type SettingControl =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'combobox'
  | 'tags'
  | 'switch';

export type SettingUnit = 'ms' | 's' | 'dB' | '×' | 'tokens' | 'chars';

export type SettingDescriptor = {
  /** Dotted key, e.g. 'tts.voice'. */
  key: string;
  section: SectionId;
  label: string;
  /** One or two sentences, shown under the field. */
  help: string;
  schema: z.ZodType;
  default: unknown;
  control: SettingControl;
  unit?: SettingUnit;
  /** number/slider: the bounds and step the form renders (they agree with `schema`). */
  min?: number;
  max?: number;
  step?: number;
  /** text/textarea: the schema's character limit, so the field can stop typing there. */
  maxLength?: number;
  /** select: the allowed values; combobox: suggestions. */
  options?: readonly string[];
  suggestFrom?: 'openai-models';
  /** May be overridden per Echo (devices.overrides). */
  perEcho: boolean;
  /** Write-only: the API returns hasKey, never the value. */
  secret?: boolean;
  applies: 'next-turn' | 'next-connect';
  advanced?: boolean;
  /** Stored and validated, but rendered by a dedicated screen (connectors). */
  hidden?: boolean;
  /** The old environment variable, for the one-time import. */
  env?: string;
};

/**
 * Layer 1 is the owner's own text: the household, place and people. The
 * built-in behaviour (identity, answer rules, tool policies) is layer 2 in
 * code, so the default here is empty. The import fills it from SystemPrompt.md.
 */
export const DEFAULT_HOUSEHOLD_PROMPT = '';

export const DEFAULT_APOLOGY_TEXT = 'Sorry, something went wrong. Please try again.';

export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffortSetting = (typeof REASONING_EFFORTS)[number];

export const FOLLOW_UP_MODES = ['tool', 'question', 'always', 'never'] as const;
export type FollowUpMode = (typeof FOLLOW_UP_MODES)[number];

const ttsVoices = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'marin',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;

const localeOptions = ['en-GB', 'en-US', 'ro-MD', 'ro-RO', 'ru-RU', 'de-DE', 'fr-FR'] as const;

const settings: readonly SettingDescriptor[] = [
  // --- Assistant ------------------------------------------------------------
  {
    key: 'assistant.householdPrompt',
    section: 'assistant',
    label: 'Household prompt',
    help: 'The assistant’s base instructions for every Echo: who it is, the home, its city and conventions, who lives here, how to answer. Each Echo can add its own text on its page. Changes apply to the next request.',
    schema: z.string().max(12000),
    maxLength: 12000,
    default: DEFAULT_HOUSEHOLD_PROMPT,
    control: 'textarea',
    unit: 'chars',
    perEcho: false,
    applies: 'next-turn',
  },
  {
    key: 'assistant.locale',
    section: 'assistant',
    label: 'Locale',
    help: 'Language and formatting of dates, times and numbers the assistant is told about.',
    schema: z.string().min(2).max(20),
    default: 'en-US',
    control: 'select',
    options: localeOptions,
    perEcho: false,
    applies: 'next-turn',
    env: 'AGENT_LOCALE',
  },
  {
    key: 'assistant.timeZone',
    section: 'assistant',
    label: 'Time zone',
    help: 'IANA zone of the home. The Echoes set their clocks from it, and every answer gets the local date and time.',
    schema: z.string().min(1).max(64),
    default: 'UTC',
    control: 'combobox',
    perEcho: false,
    applies: 'next-turn',
    env: 'TZ',
  },
  {
    key: 'assistant.sessionIdleMinutes',
    section: 'assistant',
    label: 'Conversation idle time',
    help: 'A conversation is forgotten after this much silence.',
    schema: z.number().int().min(0).max(1440),
    min: 0,
    max: 1440,
    step: 1,
    default: 5,
    control: 'number',
    perEcho: false,
    applies: 'next-turn',
    env: 'SESSION_IDLE_MINUTES',
  },
  {
    key: 'assistant.apologyText',
    section: 'assistant',
    label: 'Apology',
    help: 'Said when a request fails before any answer.',
    schema: z.string().min(1).max(500),
    maxLength: 500,
    default: DEFAULT_APOLOGY_TEXT,
    control: 'text',
    perEcho: false,
    applies: 'next-turn',
    env: 'APOLOGY_TEXT',
  },
  // --- Understanding --------------------------------------------------------
  {
    key: 'stt.model',
    section: 'understanding',
    label: 'Speech-to-text model',
    help: 'The OpenAI model that turns the recorded request into text.',
    schema: z.string().min(1).max(100),
    default: 'gpt-transcribe',
    control: 'combobox',
    suggestFrom: 'openai-models',
    perEcho: false,
    applies: 'next-turn',
    env: 'STT_MODEL',
  },
  {
    key: 'stt.languages',
    section: 'understanding',
    label: 'Languages',
    help: 'ISO-639-1 hints for recognition (e.g. en, ro). Empty = detect automatically.',
    schema: z.array(z.string().regex(/^[a-z]{2}$/)).max(10),
    default: [],
    control: 'tags',
    perEcho: true,
    applies: 'next-turn',
    env: 'STT_LANGUAGES',
  },
  {
    key: 'stt.prompt',
    section: 'understanding',
    label: 'Recognition hints',
    help: 'Names, places and jargon the transcriber should expect.',
    schema: z.string().max(1000),
    maxLength: 1000,
    default: '',
    control: 'textarea',
    perEcho: true,
    applies: 'next-turn',
    env: 'STT_PROMPT',
  },
  {
    key: 'stt.eagerSilenceMs',
    section: 'listening',
    label: 'Start transcribing early',
    help: 'Transcription starts after this much silence, before the end of the utterance is decided. 0 = wait for the end.',
    schema: z.number().int().min(0).max(5000),
    min: 0,
    max: 5000,
    step: 100,
    default: 300,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    advanced: true,
    env: 'STT_EAGER_SILENCE_MS',
  },
  // --- Thinking -------------------------------------------------------------
  {
    key: 'agent.model',
    section: 'thinking',
    label: 'Model',
    help: 'The model that answers and calls the tools.',
    schema: z.string().min(1).max(100),
    default: 'gpt-5.4-mini',
    control: 'combobox',
    suggestFrom: 'openai-models',
    perEcho: false,
    applies: 'next-turn',
    env: 'AGENT_MODEL',
  },
  {
    key: 'agent.reasoningEffort',
    section: 'thinking',
    label: 'Reasoning effort',
    help: 'How long the model may think. “default” lets it decide.',
    schema: z.enum(REASONING_EFFORTS),
    default: 'low',
    control: 'select',
    options: REASONING_EFFORTS,
    perEcho: false,
    applies: 'next-turn',
    env: 'AGENT_REASONING_EFFORT',
  },
  {
    key: 'agent.webSearch',
    section: 'thinking',
    label: 'Web search',
    help: 'Lets the model search the web for facts it does not know.',
    schema: z.boolean(),
    default: true,
    control: 'switch',
    perEcho: false,
    applies: 'next-turn',
    env: 'AGENT_WEB_SEARCH_ENABLED',
  },
  {
    key: 'agent.maxOutputTokens',
    section: 'thinking',
    label: 'Maximum answer length',
    help: 'Upper bound on the output tokens of one model response. Reasoning and web-search queries count too, not only the spoken words, so a low cap cuts off search answers. This is a safety cap.',
    schema: z.number().int().min(16).max(16000),
    min: 16,
    max: 16000,
    step: 1,
    // 600 cut off a web-search turn on 2026-11-15 (status "incomplete"):
    // reasoning and search queries used up the budget before the answer.
    default: 2000,
    control: 'number',
    unit: 'tokens',
    perEcho: false,
    applies: 'next-turn',
    env: 'AGENT_MAX_OUTPUT_TOKENS',
  },
  {
    key: 'agent.maxToolRounds',
    section: 'thinking',
    label: 'Maximum tool rounds',
    help: 'How many rounds of tool calls the model may make before it has to answer.',
    schema: z.number().int().min(1).max(10),
    min: 1,
    max: 10,
    step: 1,
    default: 4,
    control: 'number',
    perEcho: false,
    applies: 'next-turn',
    env: 'AGENT_MAX_TOOL_ROUNDS',
  },
  {
    key: 'connectors.enabled',
    section: 'thinking',
    label: 'Connected services',
    help: 'Offer the tools of connected services (Settings → Connectors) to the agent. Off = no connector tools for anyone.',
    schema: z.boolean(),
    default: true,
    control: 'switch',
    perEcho: false,
    applies: 'next-turn',
  },
  {
    key: 'connectors.disabled',
    section: 'thinking',
    label: 'Disabled connectors',
    help: 'Connectors this Echo may not use. Edit the list on the Echo’s Connectors tab.',
    schema: z.array(z.string().regex(/^[a-z][a-z0-9]{1,15}$/)).max(50),
    default: [],
    control: 'tags',
    perEcho: true,
    applies: 'next-turn',
    hidden: true,
  },
  {
    key: 'connectors.confirmWindowS',
    section: 'thinking',
    label: 'Confirmation window',
    help: 'How long a “confirm by voice” request stays valid while the user answers yes or no.',
    schema: z.number().int().min(10).max(600),
    min: 10,
    max: 600,
    step: 5,
    default: 60,
    control: 'number',
    unit: 's',
    perEcho: false,
    applies: 'next-turn',
  },
  // --- Voice ----------------------------------------------------------------
  {
    key: 'tts.model',
    section: 'voice',
    label: 'Text-to-speech model',
    help: 'The OpenAI model that speaks the answer.',
    schema: z.string().min(1).max(100),
    default: 'gpt-4o-mini-tts',
    control: 'combobox',
    suggestFrom: 'openai-models',
    perEcho: false,
    applies: 'next-turn',
    env: 'TTS_MODEL',
  },
  {
    key: 'tts.voice',
    section: 'voice',
    label: 'Voice',
    help: 'The voice every Echo uses unless it has its own.',
    schema: z.string().min(1).max(50),
    default: 'marin',
    control: 'combobox',
    options: ttsVoices,
    perEcho: true,
    applies: 'next-turn',
    env: 'TTS_VOICE',
  },
  {
    key: 'tts.speed',
    section: 'voice',
    label: 'Speed',
    help: 'Speaking rate. Below 1 is slower, above 1 faster.',
    schema: z.number().min(0.5).max(2),
    min: 0.5,
    max: 2,
    step: 0.05,
    default: 1,
    control: 'slider',
    unit: '×',
    perEcho: true,
    applies: 'next-turn',
    env: 'TTS_SPEED',
  },
  {
    key: 'tts.instructions',
    section: 'voice',
    label: 'Voice instructions',
    help: 'How the voice should sound (tone, pace, warmth). Not supported by the older tts-1 models.',
    schema: z.string().max(1000),
    maxLength: 1000,
    default: 'Speak clearly, warmly and at a natural pace.',
    control: 'textarea',
    perEcho: true,
    applies: 'next-turn',
    env: 'TTS_INSTRUCTIONS',
  },
  {
    key: 'tts.outputRate',
    section: 'voice',
    label: 'Output sample rate',
    help: 'Resample the reply audio. 0 = leave OpenAI’s 24 kHz unchanged; hassmic resamples anyway.',
    schema: z.number().int().min(0).max(48000),
    default: 0,
    control: 'select',
    options: ['0', '16000', '22050', '24000', '48000'],
    perEcho: false,
    applies: 'next-turn',
    advanced: true,
    env: 'TTS_OUTPUT_RATE',
  },
  // --- Conversation ---------------------------------------------------------
  {
    key: 'followUp.mode',
    section: 'conversation',
    label: 'Follow-up',
    help: 'When the Echo keeps listening after an answer without the wake word: the model asks (tool), only on a question mark (question), always, or never.',
    schema: z.enum(FOLLOW_UP_MODES),
    default: 'tool',
    control: 'select',
    options: FOLLOW_UP_MODES,
    perEcho: true,
    applies: 'next-turn',
    env: 'FOLLOW_UP_MODE',
  },
  {
    key: 'followUp.questionMarkFallback',
    section: 'conversation',
    label: 'Listen after a question mark',
    help: 'In tool mode, also listen when the answer ends with a question mark.',
    schema: z.boolean(),
    default: false,
    control: 'switch',
    perEcho: false,
    applies: 'next-turn',
    env: 'FOLLOW_UP_QUESTION_MARK_FALLBACK',
  },
  {
    key: 'followUp.minWaitMs',
    section: 'conversation',
    label: 'Shortest wait',
    help: 'Lower bound of the wait the model may pick for an answer.',
    schema: z.number().int().min(1000).max(20000),
    min: 1000,
    max: 20000,
    step: 500,
    default: 4000,
    control: 'slider',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    env: 'FOLLOW_UP_MIN_WAIT_MS',
  },
  {
    key: 'followUp.maxWaitMs',
    section: 'conversation',
    label: 'Longest wait',
    help: 'Upper bound of the wait. hassmic stops listening after 30 s, so this stays at 20 s or less.',
    schema: z.number().int().min(1000).max(20000),
    min: 1000,
    max: 20000,
    step: 500,
    default: 20000,
    control: 'slider',
    unit: 'ms',
    perEcho: true,
    applies: 'next-turn',
    env: 'FOLLOW_UP_MAX_WAIT_MS',
  },
  // --- Listening ------------------------------------------------------------
  {
    key: 'vad.minSpeechDb',
    section: 'listening',
    label: 'Silence threshold',
    help: 'Frames quieter than this never count as speech.',
    schema: z.number().min(-80).max(-20),
    min: -80,
    max: -20,
    step: 1,
    default: -50,
    control: 'slider',
    unit: 'dB',
    perEcho: true,
    applies: 'next-turn',
    env: 'VAD_MIN_SPEECH_DB',
  },
  {
    key: 'vad.speechMarginDb',
    section: 'listening',
    label: 'Margin above noise',
    help: 'A frame counts as speech when it is this many dB above the room’s noise floor.',
    schema: z.number().min(3).max(30),
    min: 3,
    max: 30,
    step: 1,
    default: 12,
    control: 'slider',
    unit: 'dB',
    perEcho: true,
    applies: 'next-turn',
    env: 'VAD_SPEECH_MARGIN_DB',
  },
  {
    key: 'vad.minSpeechMs',
    section: 'listening',
    label: 'Shortest speech',
    help: 'Speech must last this long before the request counts as spoken.',
    schema: z.number().int().min(0).max(2000),
    min: 0,
    max: 2000,
    step: 10,
    default: 150,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    env: 'VAD_MIN_SPEECH_MS',
  },
  {
    key: 'vad.endSilenceMs',
    section: 'listening',
    label: 'End silence',
    help: 'Silence after speech that ends the request. Lower is faster; too low cuts a pause between sentences.',
    schema: z.number().int().min(100).max(2000),
    min: 100,
    max: 2000,
    step: 50,
    default: 800,
    control: 'slider',
    unit: 'ms',
    perEcho: true,
    applies: 'next-turn',
    env: 'VAD_END_SILENCE_MS',
  },
  {
    key: 'vad.noSpeechTimeoutMs',
    section: 'listening',
    label: 'Wait for speech',
    help: 'Give up when nobody starts speaking for this long.',
    schema: z.number().int().min(500).max(20000),
    min: 500,
    max: 20000,
    step: 500,
    default: 8000,
    control: 'slider',
    unit: 'ms',
    perEcho: true,
    applies: 'next-turn',
    env: 'VAD_NO_SPEECH_TIMEOUT_MS',
  },
  {
    key: 'vad.maxUtteranceMs',
    section: 'listening',
    label: 'Longest request',
    help: 'Hard cap on one spoken request.',
    schema: z.number().int().min(1000).max(25000),
    min: 1000,
    max: 25000,
    step: 500,
    default: 15000,
    control: 'slider',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    env: 'VAD_MAX_UTTERANCE_MS',
  },
  // --- Timing ---------------------------------------------------------------
  {
    key: 'reply.prebufferMs',
    section: 'timing',
    label: 'Reply pre-buffer',
    help: 'Audio held back before the Echo is given the reply URL, so playback starts without a gap.',
    schema: z.number().int().min(0).max(2000),
    min: 0,
    max: 2000,
    step: 50,
    default: 400,
    control: 'slider',
    unit: 'ms',
    perEcho: true,
    applies: 'next-turn',
    env: 'REPLY_PREBUFFER_MS',
  },
  {
    key: 'pipeline.turnDeadlineMs',
    section: 'timing',
    label: 'Turn deadline',
    help: 'If no answer has reached the Echo this long after speech ends, the turn is aborted with an apology.',
    schema: z.number().int().min(5000).max(60000),
    min: 5000,
    max: 60000,
    step: 1000,
    default: 24000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    env: 'TURN_DEADLINE_MS',
  },
  // --- Advanced -------------------------------------------------------------
  {
    key: 'openai.timeoutMs',
    section: 'advanced',
    label: 'OpenAI timeout',
    help: 'Per-request timeout for OpenAI calls.',
    schema: z.number().int().min(1000).max(120000),
    min: 1000,
    max: 120000,
    step: 1000,
    default: 20000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    advanced: true,
    env: 'OPENAI_TIMEOUT_MS',
  },
  {
    key: 'openai.apiKey',
    section: 'advanced',
    label: 'OpenAI API key',
    help: 'The account key. It is never shown again after saving; enter a new one to replace it.',
    schema: z.string().min(1).max(200).nullable(),
    default: null,
    control: 'text',
    perEcho: false,
    secret: true,
    applies: 'next-turn',
    advanced: true,
    env: 'OPENAI_API_KEY',
  },
  {
    key: 'echo.duplicateWakeWindowMs',
    section: 'advanced',
    label: 'Duplicate wake window',
    help: 'Two Echos answering the same wake word within this window: the later run is ended quietly. 0 = off.',
    schema: z.number().int().min(0).max(10000),
    min: 0,
    max: 10000,
    step: 100,
    default: 2000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    advanced: true,
  },
  {
    key: 'echo.reconnectMinMs',
    section: 'advanced',
    label: 'Reconnect delay (min)',
    help: 'Shortest wait before reconnecting a dropped link.',
    schema: z.number().int().min(100).max(60000),
    min: 100,
    max: 60000,
    step: 100,
    default: 1000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-connect',
    advanced: true,
    env: 'ECHO_RECONNECT_MIN_MS',
  },
  {
    key: 'echo.reconnectMaxMs',
    section: 'advanced',
    label: 'Reconnect delay (max)',
    help: 'Longest wait before reconnecting a dropped link (the backoff doubles up to this).',
    schema: z.number().int().min(100).max(60000),
    min: 100,
    max: 60000,
    step: 100,
    default: 30000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-connect',
    advanced: true,
    env: 'ECHO_RECONNECT_MAX_MS',
  },
  {
    key: 'echo.pingIntervalMs',
    section: 'advanced',
    label: 'Ping interval',
    help: 'How often an idle link is checked with a ping.',
    schema: z.number().int().min(500).max(120000),
    min: 500,
    max: 120000,
    step: 500,
    default: 10000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-connect',
    advanced: true,
    env: 'ECHO_PING_INTERVAL_MS',
  },
  {
    key: 'echo.pingTimeoutMs',
    section: 'advanced',
    label: 'Ping timeout',
    help: 'No answer to a ping for this long means the link is dead and is reconnected.',
    schema: z.number().int().min(1000).max(180000),
    min: 1000,
    max: 180000,
    step: 500,
    default: 25000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-connect',
    advanced: true,
    env: 'ECHO_PING_TIMEOUT_MS',
  },
  {
    key: 'echo.playedGraceMs',
    section: 'advanced',
    label: 'Playback grace',
    help: 'Extra time to wait for the Echo’s “played” report, on top of the audio’s length.',
    schema: z.number().int().min(500).max(60000),
    min: 500,
    max: 60000,
    step: 500,
    default: 8000,
    control: 'number',
    unit: 'ms',
    perEcho: false,
    applies: 'next-turn',
    advanced: true,
    env: 'ECHO_PLAYED_GRACE_MS',
  },
];

export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = settings;

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDescriptor> = new Map(
  settings.map((descriptor) => [descriptor.key, descriptor]),
);

/** The built-in defaults, flat. */
export const DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze(
  Object.fromEntries(settings.map((descriptor) => [descriptor.key, descriptor.default])),
);

export const SECRET_SETTING_KEYS: readonly string[] = settings
  .filter((descriptor) => descriptor.secret === true)
  .map((descriptor) => descriptor.key);

export function isSecretSetting(key: string): boolean {
  return SETTING_BY_KEY.get(key)?.secret === true;
}

/** The descriptor's options as values (selects render strings; numbers convert). */
export function settingOptions(descriptor: SettingDescriptor): readonly string[] {
  return descriptor.options ?? [];
}

// ---------------------------------------------------------------------------
// The resolved settings, as the API uses them.
// ---------------------------------------------------------------------------

export type Settings = {
  assistant: {
    householdPrompt: string;
    locale: string;
    timeZone: string;
    sessionIdleMinutes: number;
    apologyText: string;
  };
  stt: { model: string; languages: string[]; prompt: string; eagerSilenceMs: number };
  agent: {
    model: string;
    reasoningEffort: ReasoningEffortSetting;
    webSearch: boolean;
    maxOutputTokens: number;
    maxToolRounds: number;
  };
  connectors: { enabled: boolean; disabled: string[]; confirmWindowS: number };
  tts: { model: string; voice: string; speed: number; instructions: string; outputRate: number };
  followUp: { mode: FollowUpMode; questionMarkFallback: boolean; minWaitMs: number; maxWaitMs: number };
  vad: {
    minSpeechDb: number;
    speechMarginDb: number;
    minSpeechMs: number;
    endSilenceMs: number;
    noSpeechTimeoutMs: number;
    maxUtteranceMs: number;
  };
  reply: { prebufferMs: number };
  pipeline: { turnDeadlineMs: number };
  openai: { timeoutMs: number; apiKey: string | null };
  echo: {
    duplicateWakeWindowMs: number;
    reconnectMinMs: number;
    reconnectMaxMs: number;
    pingIntervalMs: number;
    pingTimeoutMs: number;
    playedGraceMs: number;
  };
};

/** Turns a flat, fully resolved value map into the nested object the API uses. */
export function buildSettings(values: Readonly<Record<string, unknown>>): Settings {
  const get = <T>(key: string): T => values[key] as T;
  return {
    assistant: {
      householdPrompt: get('assistant.householdPrompt'),
      locale: get('assistant.locale'),
      timeZone: get('assistant.timeZone'),
      sessionIdleMinutes: get('assistant.sessionIdleMinutes'),
      apologyText: get('assistant.apologyText'),
    },
    stt: {
      model: get('stt.model'),
      languages: get('stt.languages'),
      prompt: get('stt.prompt'),
      eagerSilenceMs: get('stt.eagerSilenceMs'),
    },
    agent: {
      model: get('agent.model'),
      reasoningEffort: get('agent.reasoningEffort'),
      webSearch: get('agent.webSearch'),
      maxOutputTokens: get('agent.maxOutputTokens'),
      maxToolRounds: get('agent.maxToolRounds'),
    },
    connectors: {
      enabled: get('connectors.enabled'),
      disabled: get('connectors.disabled'),
      confirmWindowS: get('connectors.confirmWindowS'),
    },
    tts: {
      model: get('tts.model'),
      voice: get('tts.voice'),
      speed: get('tts.speed'),
      instructions: get('tts.instructions'),
      outputRate: get('tts.outputRate'),
    },
    followUp: {
      mode: get('followUp.mode'),
      questionMarkFallback: get('followUp.questionMarkFallback'),
      minWaitMs: get('followUp.minWaitMs'),
      maxWaitMs: get('followUp.maxWaitMs'),
    },
    vad: {
      minSpeechDb: get('vad.minSpeechDb'),
      speechMarginDb: get('vad.speechMarginDb'),
      minSpeechMs: get('vad.minSpeechMs'),
      endSilenceMs: get('vad.endSilenceMs'),
      noSpeechTimeoutMs: get('vad.noSpeechTimeoutMs'),
      maxUtteranceMs: get('vad.maxUtteranceMs'),
    },
    reply: { prebufferMs: get('reply.prebufferMs') },
    pipeline: { turnDeadlineMs: get('pipeline.turnDeadlineMs') },
    openai: { timeoutMs: get('openai.timeoutMs'), apiKey: get('openai.apiKey') },
    echo: {
      duplicateWakeWindowMs: get('echo.duplicateWakeWindowMs'),
      reconnectMinMs: get('echo.reconnectMinMs'),
      reconnectMaxMs: get('echo.reconnectMaxMs'),
      pingIntervalMs: get('echo.pingIntervalMs'),
      pingTimeoutMs: get('echo.pingTimeoutMs'),
      playedGraceMs: get('echo.playedGraceMs'),
    },
  };
}
