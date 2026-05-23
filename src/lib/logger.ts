/**
 * Minimal structured logger. Emits one JSON object per line on stdout/stderr,
 * which is the format Azure Log Stream, Datadog, and most other tools expect.
 *
 * Request-scoped correlation is achieved via AsyncLocalStorage: the Express
 * middleware in `requestLogger.ts` opens a context with `requestId`, and any
 * `log.*` call inside that handler automatically picks it up.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

interface LogContext {
  requestId?: string;
  [key: string]: unknown;
}

const contextStore = new AsyncLocalStorage<LogContext>();

let configuredLevel: Level = 'info';

export function setLogLevel(level: Level): void {
  configuredLevel = level;
}

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...(contextStore.getStore() ?? {}), ...ctx };
  return contextStore.run(merged, fn);
}

function emit(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[configuredLevel]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(contextStore.getStore() ?? {}),
    ...(extra ?? {})
  };

  const line = JSON.stringify(record);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra)
};
