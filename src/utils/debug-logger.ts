import config from '../config';

export type DebugChannel =
  | 'plan'
  | 'hybrid'
  | 'qa'
  | 'sse'
  | 'llm'
  | 'openai'
  | 'server';

type DebugLevel = 'log' | 'info' | 'warn' | 'error';

const ALL_CHANNELS: DebugChannel[] = ['plan', 'hybrid', 'qa', 'sse', 'llm', 'openai', 'server'];

const parseEnabledChannels = (): Set<DebugChannel> => {
  const set = new Set<DebugChannel>();
  const raw = (config.DEBUG_CHANNELS || '').toString();
  if (!raw) return set;

  for (const token of raw.split(',')) {
    const key = token.trim().toLowerCase();
    if (!key) continue;
    const match = ALL_CHANNELS.find((ch) => ch === key);
    if (match) set.add(match);
  }
  return set;
};

const enabledAll = (config.DEBUG_ALL || '').toString().toLowerCase() === 'true';
const enabledChannels = parseEnabledChannels();

const pickWriter = (level: DebugLevel) => {
  switch (level) {
    case 'info':
      return console.info.bind(console);
    case 'warn':
      return console.warn.bind(console);
    case 'error':
      return console.error.bind(console);
    case 'log':
    default:
      return console.log.bind(console);
  }
};

const toInlineValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > 80 ? `"${trimmed.slice(0, 77)}..."` : `"${trimmed}"`;
  }
  if (Array.isArray(value)) {
    const preview = value.slice(0, 3).map(toInlineValue).join(', ');
    return `[${preview}${value.length > 3 ? ', ...' : ''}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatObjectPayload = (channel: DebugChannel, payload: Record<string, unknown>): string => {
  const { type, ...rest } = payload;
  const hasType = type !== undefined && type !== null;
  const typeLabel =
    typeof type === 'string' ? ` ${type}` : hasType ? ` ${toInlineValue(type)}` : '';
  const header = `[debug][${channel}]${typeLabel}`;
  const keys = Object.keys(rest);
  if (keys.length === 0) return header;
  try {
    const body = JSON.stringify(rest, null, 2);
    return `${header}\n${body}`;
  } catch {
    const parts = keys.map((key) => `${key}=${toInlineValue(rest[key])}`);
    return `${header}\n${parts.map((line) => `  ${line}`).join('\n')}`;
  }
};

const formatPayload = (channel: DebugChannel, payload: unknown): string => {
  if (typeof payload === 'string') return `[debug][${channel}] ${payload}`;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return formatObjectPayload(channel, payload as Record<string, unknown>);
  }
  return `[debug][${channel}] ${toInlineValue(payload)}`;
};

// 채널 기반으로 디버그 로그를 조건부 출력
export const DebugLogger = {
  isEnabled(channel: DebugChannel): boolean {
    return enabledAll || enabledChannels.has(channel);
  },
  write(channel: DebugChannel, payload: unknown, level: DebugLevel = 'log'): void {
    if (!this.isEnabled(channel)) return;
    const writer = pickWriter(level);
    writer(formatPayload(channel, payload));
  },
  log(channel: DebugChannel, payload: unknown): void {
    this.write(channel, payload, 'log');
  },
  info(channel: DebugChannel, payload: unknown): void {
    this.write(channel, payload, 'info');
  },
  warn(channel: DebugChannel, payload: unknown): void {
    this.write(channel, payload, 'warn');
  },
  error(channel: DebugChannel, payload: unknown): void {
    this.write(channel, payload, 'error');
  },
};

export const isDebugChannelEnabled = (channel: DebugChannel): boolean => DebugLogger.isEnabled(channel);
