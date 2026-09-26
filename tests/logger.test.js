/**
 * Logger record integrity (BUG 4).
 *
 * Before the fix, metadata was spread over the record, so
 * log.warn('request rejected', { message: 'Amount invalid' }) logged
 * "message":"Amount invalid" and the event name was lost.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/lib/logger.js';

/** Capture the JSON lines a logger writes to stdout and stderr. */
function capture(fn) {
  const lines = [];
  const original = { out: process.stdout.write, err: process.stderr.write };
  const collect = (chunk) => {
    lines.push(JSON.parse(String(chunk)));
    return true;
  };
  process.stdout.write = collect;
  process.stderr.write = collect;
  try {
    fn();
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
  return lines;
}

test('a metadata `message` never overwrites the event name', () => {
  const [record] = capture(() => createLogger({ level: 'info' }).warn('request rejected', {
    code: 'VALIDATION_ERROR',
    message: 'Amount invalid',
  }));
  assert.equal(record.message, 'request rejected');
  assert.equal(record['meta.message'], 'Amount invalid', 'the metadata value is kept, not dropped');
  assert.equal(record.code, 'VALIDATION_ERROR');
  assert.equal(record.level, 'warn');
});

test('no reserved field can be overwritten by metadata', () => {
  const [record] = capture(() => createLogger({ level: 'info', name: 'ifrsmart:req_1' }).info('event', {
    time: 'forged-time',
    level: 'fatal',
    message: 'forged',
    logger: 'forged-logger',
  }));
  assert.equal(record.message, 'event');
  assert.equal(record.level, 'info');
  assert.equal(record.logger, 'ifrsmart:req_1');
  assert.notEqual(record.time, 'forged-time');
  assert.deepEqual(
    [record['meta.time'], record['meta.level'], record['meta.message'], record['meta.logger']],
    ['forged-time', 'fatal', 'forged', 'forged-logger'],
  );
});

test('child loggers keep the request id and the event name', () => {
  const [record] = capture(() => createLogger({ level: 'info' }).child({ requestId: 'req_abc' }).error('unhandled error', {
    error: new Error('boom'),
  }));
  assert.equal(record.message, 'unhandled error');
  assert.equal(record.logger, 'ifrsmart:req_abc');
  assert.equal(record.error.message, 'boom');
  assert.match(record.error.stack, /boom/, 'the stack stays in server-side logs for diagnosis');
});

test('an error cause chain is logged', () => {
  const [record] = capture(() => createLogger({ level: 'info' }).error('failed', {
    error: new Error('outer', { cause: new Error('inner') }),
  }));
  assert.equal(record.error.cause.message, 'inner');
});

test('secrets are still redacted', () => {
  const [record] = capture(() => createLogger({ level: 'info' }).info('login', {
    email: 'owner@example.com',
    password: 'hunter2',
    nested: { token: 'abc' },
  }));
  assert.equal(record.password, '[redacted]');
  assert.equal(record.nested.token, '[redacted]');
  assert.equal(record.email, 'owner@example.com');
});

// Found while fixing BUG 4: 'silent' ranked highest (5), so as a threshold it
// let every level through — LOG_LEVEL=silent logged everything.
test('LOG_LEVEL=silent writes nothing; other levels filter by severity', () => {
  const silent = createLogger({ level: 'silent' });
  assert.deepEqual(capture(() => {
    silent.fatal('x');
    silent.error('x');
    silent.info('x');
    silent.child({ requestId: 'req_1' }).error('x');
  }), []);

  const warn = createLogger({ level: 'warn' });
  const records = capture(() => {
    warn.error('e');
    warn.warn('w');
    warn.info('i');
    warn.debug('d');
  });
  assert.deepEqual(records.map((record) => record.message), ['e', 'w']);
});

test('a failing output stream never makes logging throw', () => {
  const original = process.stdout.write;
  process.stdout.write = () => {
    throw new Error('EPIPE');
  };
  try {
    assert.doesNotThrow(() => createLogger({ level: 'info' }).info('still fine', { a: 1 }));
  } finally {
    process.stdout.write = original;
  }
});
