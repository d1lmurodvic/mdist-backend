import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

const MINIMAL = { NODE_ENV: 'test', DATABASE_ALLOW_MEMORY: 'true' };

test('loadConfig applies documented defaults', () => {
  const config = loadConfig(MINIMAL);
  assert.equal(config.server.port, 4000);
  assert.equal(config.session.ttlSeconds, 86400);
  assert.equal(config.security.passwordMinLength, 8);
  assert.equal(config.storage.maxBytes, 10 * 1024 * 1024, '10 MB upload cap');
  assert.equal(config.ai.enabled, false, 'AI is optional and off by default');
  assert.equal(config.database.path.endsWith('ifrsmart.sqlite'), true);
});

test('loadConfig is frozen so config cannot drift at runtime', () => {
  const config = loadConfig(MINIMAL);
  assert.equal(Object.isFrozen(config), true);
  assert.throws(() => {
    config.server.port = 9999;
  }, TypeError);
});

test('AI stays disabled when no provider is configured', () => {
  const config = loadConfig({ ...MINIMAL, AI_PROVIDER: '', AI_API_KEY: '', AI_MODEL: '' });
  assert.equal(config.ai.enabled, false);
  assert.equal(config.ai.provider, '');
});

test('a half-configured AI provider fails fast rather than failing at call time', () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL, AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test' }),
    /AI_MODEL/,
  );
  assert.throws(
    () => loadConfig({ ...MINIMAL, AI_PROVIDER: 'openai' }),
    /AI_API_KEY[\s\S]*AI_MODEL/,
  );
});

test('a fully configured AI provider is accepted', () => {
  const config = loadConfig({
    ...MINIMAL,
    AI_PROVIDER: 'openai',
    AI_API_KEY: 'sk-test',
    AI_MODEL: 'gpt-test',
  });
  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.provider, 'openai');
});

test('invalid configuration is rejected with every problem listed', () => {
  try {
    loadConfig({ NODE_ENV: 'test', PORT: 'not-a-port', PASSWORD_MIN_LENGTH: '2', SESSION_TTL_SECONDS: '1' });
    assert.fail('Expected loadConfig to throw');
  } catch (error) {
    assert.match(error.message, /Invalid configuration/);
    assert.match(error.message, /PORT/);
    assert.match(error.message, /PASSWORD_MIN_LENGTH/);
    assert.match(error.message, /SESSION_TTL_SECONDS/);
  }
});

test('production refuses a wildcard CORS origin', () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL, NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' }),
    /must not be "\*"/,
  );
});

test('in-memory database requires an explicit opt-in', () => {
  const config = loadConfig({ ...MINIMAL, DATABASE_PATH: ':memory:', DATABASE_ALLOW_MEMORY: 'false' });
  assert.equal(config.database.isMemory, true);
  assert.equal(config.database.allowMemory, false);
});

// Regression (BUG 2): with Zod 4, `.default('false')` after a transform
// returned the STRING 'false' — truthy — when SESSION_BIND_IP was absent.
test('boolean settings are real booleans, and absent means false', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.session.bindIp, false);
  assert.equal(typeof config.session.bindIp, 'boolean');
  assert.equal(config.database.allowMemory, false);
  assert.equal(typeof config.database.allowMemory, 'boolean');
});

test('explicit boolean values parse correctly', () => {
  for (const [raw, expected] of [['true', true], ['1', true], ['false', false], ['0', false]]) {
    const config = loadConfig({ NODE_ENV: 'test', SESSION_BIND_IP: raw, DATABASE_ALLOW_MEMORY: raw });
    assert.equal(config.session.bindIp, expected, `SESSION_BIND_IP=${raw}`);
    assert.equal(config.database.allowMemory, expected, `DATABASE_ALLOW_MEMORY=${raw}`);
  }
});

test('invalid boolean values are rejected rather than guessed', () => {
  for (const raw of ['yes', 'no', 'TRUE', 'on', '']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', SESSION_BIND_IP: raw }), /SESSION_BIND_IP/, `"${raw}"`);
  }
});

test('CORS origins must be exact origins', () => {
  for (const bad of [
    'http://localhost:5173/',
    'localhost:5173',
    'http://localhost:5173/app',
    'HTTP://LOCALHOST:5173',
    'ftp://files.example.com',
    'null',
  ]) {
    assert.throws(
      () => loadConfig({ ...MINIMAL, CORS_ALLOWED_ORIGINS: bad }),
      /CORS_ALLOWED_ORIGINS[\s\S]*not an exact origin/,
      bad,
    );
  }
});

test('a wildcard CORS origin must stand alone', () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL, CORS_ALLOWED_ORIGINS: '*, http://localhost:5173' }),
    /cannot be combined/,
  );
  assert.deepEqual([...loadConfig({ ...MINIMAL, CORS_ALLOWED_ORIGINS: '*' }).server.corsAllowedOrigins], ['*']);
});

test('CORS origins are parsed into a list', () => {
  const config = loadConfig({
    ...MINIMAL,
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173, https://app.example.com',
  });
  assert.deepEqual(config.server.corsAllowedOrigins, ['http://localhost:5173', 'https://app.example.com']);
});
