/**
 * Google OAuth access tokens without a Google SDK (the backend's only runtime
 * dependency is zod). Two credential shapes are accepted, the same JSON files
 * Google's own libraries read:
 *
 * - service_account: a signed JWT (RS256, node:crypto) exchanged for a token
 *   (https://developers.google.com/identity/protocols/oauth2/service-account)
 * - authorized_user: the refresh token that `gcloud auth application-default
 *   login` stores, exchanged for a token
 *
 * Tokens are cached until a minute before they expire; concurrent callers
 * share one refresh. Nothing here logs a credential or a token.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 60_000;

const configError = (message) => new Error(`Invalid configuration:\n  - ${message}`);

/**
 * Parse credentials from inline JSON (GOOGLE_APPLICATION_CREDENTIALS_JSON) or
 * a file path (GOOGLE_APPLICATION_CREDENTIALS). Throws a configuration error
 * naming the setting, never echoing its content.
 */
export function loadGoogleCredentials({ file, json }) {
  const source = json ? 'GOOGLE_APPLICATION_CREDENTIALS_JSON' : 'GOOGLE_APPLICATION_CREDENTIALS';
  let text = json;
  if (!text) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw configError(`${source} points to a file that cannot be read`);
    }
  }
  let credentials;
  try {
    credentials = JSON.parse(text);
  } catch {
    throw configError(`${source} is not valid JSON`);
  }

  if (credentials?.type === 'service_account') {
    if (typeof credentials.client_email !== 'string' || typeof credentials.private_key !== 'string') {
      throw configError(`${source}: a service account key needs client_email and private_key`);
    }
    try {
      crypto.createPrivateKey(credentials.private_key);
    } catch {
      throw configError(`${source}: the service account private_key cannot be parsed`);
    }
    return credentials;
  }
  if (credentials?.type === 'authorized_user') {
    for (const key of ['client_id', 'client_secret', 'refresh_token']) {
      if (typeof credentials[key] !== 'string' || !credentials[key]) throw configError(`${source}: authorized_user credentials need ${key}`);
    }
    return credentials;
  }
  throw configError(`${source} must be a service_account or authorized_user credentials file`);
}

const base64url = (value) => Buffer.from(value).toString('base64url');

function signedAssertion(credentials, tokenUri, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT', ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}) };
  const claims = { iss: credentials.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: tokenUri, iat: nowSeconds, exp: nowSeconds + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function createGoogleTokenProvider({ credentials, fetch = globalThis.fetch, now = Date.now }) {
  const tokenUri = credentials.token_uri || DEFAULT_TOKEN_URI;
  let cached = null;
  let inFlight = null;

  function requestBody() {
    if (credentials.type === 'service_account') {
      return new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedAssertion(credentials, tokenUri, Math.floor(now() / 1000)),
      });
    }
    return new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
    });
  }

  async function refresh(signal) {
    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestBody(),
      signal,
    });
    if (!response.ok) {
      // The body may echo request details; only the status leaves this module.
      const error = new Error(`Google token endpoint responded ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    if (typeof body?.access_token !== 'string' || !body.access_token) throw new Error('Google token endpoint returned no access token');
    const lifetimeMs = (Number.isFinite(body.expires_in) ? body.expires_in : 3600) * 1000;
    cached = { token: body.access_token, expiresAt: now() + lifetimeMs };
    return cached.token;
  }

  return {
    /** Sent as x-goog-user-project: user credentials need a quota project; service accounts do not. */
    isUserCredential: credentials.type === 'authorized_user',

    async accessToken(signal) {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;
      inFlight ??= refresh(signal).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
