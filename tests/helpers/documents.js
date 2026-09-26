/**
 * Document test helpers: sample files with real signatures, a multipart
 * builder, an isolated upload directory, apps with a stand-in AI adapter, and
 * a poller for the asynchronous extraction.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp } from './testApp.js';
import { loadConfig } from '../../src/config/index.js';
import { createDocumentReader } from '../../src/ai/documentReader.js';

/** Minimal files that carry each format's real signature. */
export const SAMPLES = Object.freeze({
  pdf: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  png: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex'),
  jpeg: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(14)]),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(12)]),
  exe: Buffer.from('4d5a90000300000004000000ffff0000', 'hex'),
  text: Buffer.from('just some text, not a document'),
});

const BOUNDARY = '----ifrsmart-test-boundary';

/** A multipart/form-data body. `parts`: [{ name, filename?, type?, bytes }]. */
export function multipart(parts) {
  const chunks = [];
  for (const part of parts) {
    let disposition = `form-data; name="${part.name}"`;
    if (part.filename !== undefined) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n`));
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`));
    chunks.push(Buffer.from('\r\n'), Buffer.from(part.bytes), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

export function uploadFile(request, token, { filename = 'receipt.pdf', type = 'application/pdf', bytes = SAMPLES.pdf } = {}) {
  const { body, contentType } = multipart([{ name: 'file', filename, type, bytes }]);
  return request('POST', '/api/v1/documents', { token, raw: body, headers: { 'Content-Type': contentType } });
}

/** Wait until extraction has finished (the upload responds while 'processing'). */
export async function settled(request, token, documentId, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request('GET', `/api/v1/documents/${documentId}`, { token });
    if (response.data?.status !== 'processing') return response;
    if (Date.now() > deadline) throw new Error(`document ${documentId} still processing after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A test app with its own upload directory. With `adapter`, an AI provider
 * named "stand-in" is configured and served by that adapter.
 */
export async function createDocumentsApp({ adapter, timeoutMs } = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifrsmart-uploads-'));
  const env = { UPLOAD_DIR: uploadDir };
  if (adapter) Object.assign(env, { AI_PROVIDER: 'stand-in', AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  const services = {};
  if (adapter) {
    const config = loadConfig({ NODE_ENV: 'test', ...env });
    services.documentReader = createDocumentReader({ config, adapters: { 'stand-in': adapter }, timeoutMs });
  }
  const app = await createTestApp({ env, services });
  const close = async () => {
    await app.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  };
  return { ...app, uploadDir, close };
}

/** Files currently stored under the upload directory (relative paths). */
export function storedFiles(uploadDir) {
  return fs.readdirSync(uploadDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(uploadDir, path.join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'));
}

/** A complete, valid provider result; override fields per test. */
export function providerResult(overrides = {}) {
  const uzs = (amount) => ({ amount, currency: 'UZS' });
  return {
    readable: true,
    documentType: { value: 'receipt', confidence: 0.97 },
    date: { value: '2025-03-14', confidence: 0.93 },
    subtotal: { value: uzs(35000), confidence: 0.9 },
    tax: { value: uzs(4200), confidence: 0.88 },
    total: { value: uzs(39200), confidence: 0.96 },
    vendor: { value: 'Korzinka', confidence: 0.91 },
    customer: { value: null, confidence: null },
    lineItems: {
      value: [{ description: 'Coffee beans', quantity: 2, unitPrice: uzs(17500), taxRate: 1200 }],
      confidence: 0.85,
    },
    ...overrides,
  };
}

export function assertNoInternalPaths(raw, uploadDir) {
  for (const needle of [uploadDir, uploadDir.replaceAll('\\', '/'), 'storage_key', 'storageKey', 'uploads/', 'cmp_']) {
    assert.ok(!raw.includes(needle), `response leaks "${needle}"`);
  }
}
