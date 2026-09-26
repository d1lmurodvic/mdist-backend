/**
 * Structured logging with mandatory redaction.
 *
 * DEVELOPMENT_RULES.md §6.3: never log passwords, session tokens, API keys,
 * secrets or document contents. Redaction is applied here rather than at each
 * call site, so a new call site cannot leak by omission.
 */

const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, silent: 5 };

/** Keys whose values are never written, at any nesting depth. */
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'sessiontoken',
  'session_token',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'privatekey',
  'prompt',
  'rawresponse',
  'buffer',
  'content',
]);

const MAX_DEPTH = 6;

/**
 * Keys the logger itself owns. Metadata can never overwrite them: a colliding
 * metadata key is kept under `meta.<key>`, so neither the event name nor the
 * metadata value is lost.
 */
const RESERVED_KEYS = new Set(['time', 'level', 'message', 'logger']);

function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    // Logs are server-side only, so the stack is kept for diagnosis.
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
      cause: value.cause === undefined ? undefined : redact(value.cause, depth + 1),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function buildRecord(level, message, loggerName, fields) {
  const record = { time: new Date().toISOString(), level, message, logger: loggerName };
  if (fields === undefined || fields === null) return record;

  const metadata = redact(fields);
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    record['meta.value'] = metadata;
    return record;
  }
  for (const [key, value] of Object.entries(metadata)) {
    record[RESERVED_KEYS.has(key) ? `meta.${key}` : key] = value;
  }
  return record;
}

/** Logging must never take a request (or the process) down with it. */
function write(level, message, loggerName, fields) {
  const stream = level === 'fatal' || level === 'error' ? process.stderr : process.stdout;
  try {
    stream.write(`${JSON.stringify(buildRecord(level, message, loggerName, fields))}\n`);
  } catch {
    try {
      stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, logger: loggerName, loggingFailed: true })}\n`);
    } catch {
      // The stream itself is unusable; nothing more can be done here.
    }
  }
}

export function createLogger({ level = 'info', name = 'ifrsmart' } = {}) {
  // 'silent' has the highest rank, so it must disable output explicitly;
  // used as a plain threshold it would let every level through.
  const threshold = level === 'silent' ? -1 : (LEVELS[level] ?? LEVELS.info);

  const emit = (levelName) => (message, fields) => {
    if (LEVELS[levelName] > threshold) return;
    write(levelName, message, name, fields);
  };

  return {
    fatal: emit('fatal'),
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    /** Returns a logger that stamps every record with extra context. */
    child(bindings) {
      return createLogger({ level, name: bindings?.requestId ? `${name}:${bindings.requestId}` : name });
    },
  };
}

export const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
