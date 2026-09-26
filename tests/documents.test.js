/**
 * Phase 5 documents: upload validation, storage, lifecycle without an AI
 * provider, file access, listing and deletion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertErrorEnvelope, assertSuccessEnvelope } from './helpers/testApp.js';
import { ownerWithCompany } from './helpers/fixtures.js';
import {
  SAMPLES, assertNoInternalPaths, createDocumentsApp, multipart, settled, storedFiles, uploadFile,
} from './helpers/documents.js';

function assertRejected(response, status, code) {
  assert.equal(response.status, status, response.raw);
  assertErrorEnvelope(response, code);
}

async function setup(options) {
  const app = await createDocumentsApp(options);
  const owner = await ownerWithCompany(app.request, { email: 'o@a.example', companyName: 'A' });
  return { ...app, ...owner };
}

// ---------------------------------------------------------------- upload

test('a PDF upload is stored and answered with status processing', async (t) => {
  const { request, token, uploadDir, db, close } = await setup();
  t.after(close);

  const response = await uploadFile(request, token, { filename: 'march-receipt.pdf' });
  assert.equal(response.status, 201);
  assertSuccessEnvelope(response);
  const document = response.data;
  assert.equal(response.headers.get('location'), `/api/v1/documents/${document.id}`);
  assert.match(document.id, /^doc_/);
  assert.deepEqual(
    [document.status, document.originalFilename, document.mimeType, document.sizeBytes, document.failure, document.confirmation, document.extraction],
    ['processing', 'march-receipt.pdf', 'application/pdf', SAMPLES.pdf.length, null, null, null],
  );
  assertNoInternalPaths(response.raw, uploadDir);

  const [stored] = storedFiles(uploadDir);
  assert.match(stored, /^cmp_[0-9A-Z]{26}\/doc_[0-9A-Z]{26}\.pdf$/, 'server-generated key, never the client filename');
  assert.deepEqual(fs.readFileSync(path.join(uploadDir, stored)), SAMPLES.pdf, 'the original bytes are kept');
  await settled(request, token, document.id);
  assert.equal(db.getValue('SELECT storage_key FROM documents'), stored);
});

test('every approved image format is accepted by its signature', async (t) => {
  const { request, token, close } = await setup();
  t.after(close);
  for (const [format, type, filename] of [
    ['png', 'image/png', 'a.png'], ['jpeg', 'image/jpeg', 'b.jpg'], ['jpeg', 'image/jpeg', 'c.JPEG'],
    ['webp', 'image/webp', 'd.webp'], ['gif', 'image/gif', 'e.gif'], ['heic', 'image/heic', 'f.heic'],
  ]) {
    const response = await uploadFile(request, token, { filename, type, bytes: SAMPLES[format] });
    assert.equal(response.status, 201, `${filename}: ${response.raw}`);
    assert.equal(response.data.mimeType, type);
    await settled(request, token, response.data.id);
  }
});

test('unsupported, disguised and mismatched files are refused with 415 and nothing is stored', async (t) => {
  const { request, token, uploadDir, db, close } = await setup();
  t.after(close);
  const cases = [
    ['an executable', { filename: 'invoice.exe', type: 'application/octet-stream', bytes: SAMPLES.exe }],
    ['an executable named .pdf', { filename: 'invoice.pdf', type: 'application/pdf', bytes: SAMPLES.exe }],
    ['plain text', { filename: 'notes.txt', type: 'text/plain', bytes: SAMPLES.text }],
    ['a PNG declared as PDF', { filename: 'scan.pdf', type: 'application/pdf', bytes: SAMPLES.png }],
    ['a PDF declared as JPEG', { filename: 'scan.jpg', type: 'image/jpeg', bytes: SAMPLES.pdf }],
    ['a PDF named .png', { filename: 'scan.png', type: 'application/pdf', bytes: SAMPLES.pdf }],
    ['a PDF with a double extension', { filename: 'scan.pdf.exe', type: 'application/pdf', bytes: SAMPLES.pdf }],
  ];
  for (const [label, file] of cases) {
    const response = await uploadFile(request, token, file);
    assert.equal(response.status, 415, `${label}: ${response.raw}`);
    assertErrorEnvelope(response, 'UNSUPPORTED_MEDIA_TYPE');
  }
  assert.deepEqual(storedFiles(uploadDir), []);
  assert.equal(db.getValue('SELECT count(*) FROM documents'), 0);
});

test('a non-multipart request is 415; a malformed or incomplete one is 400', async (t) => {
  const { request, token, uploadDir, close } = await setup();
  t.after(close);

  assertRejected(await request('POST', '/api/v1/documents', { token, body: { file: 'base64...' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assertRejected(await request('POST', '/api/v1/documents', { token, raw: SAMPLES.pdf, headers: { 'Content-Type': 'application/pdf' } }), 415, 'UNSUPPORTED_MEDIA_TYPE');

  const malformed = await request('POST', '/api/v1/documents', {
    token, raw: 'not multipart at all', headers: { 'Content-Type': 'multipart/form-data; boundary=zz' },
  });
  assertRejected(malformed, 400, 'VALIDATION_ERROR');

  const variants = [
    ['no file part', [{ name: 'note', bytes: 'hello' }]],
    ['wrong field name', [{ name: 'document', filename: 'a.pdf', type: 'application/pdf', bytes: SAMPLES.pdf }]],
    ['two files', [
      { name: 'file', filename: 'a.pdf', type: 'application/pdf', bytes: SAMPLES.pdf },
      { name: 'file', filename: 'b.pdf', type: 'application/pdf', bytes: SAMPLES.pdf },
    ]],
    ['an extra field', [
      { name: 'file', filename: 'a.pdf', type: 'application/pdf', bytes: SAMPLES.pdf },
      { name: 'companyId', bytes: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' },
    ]],
    ['file sent as a text field', [{ name: 'file', bytes: '%PDF-1.4' }]],
    ['an empty file', [{ name: 'file', filename: 'a.pdf', type: 'application/pdf', bytes: Buffer.alloc(0) }]],
  ];
  for (const [label, parts] of variants) {
    const { body, contentType } = multipart(parts);
    const response = await request('POST', '/api/v1/documents', { token, raw: body, headers: { 'Content-Type': contentType } });
    assert.equal(response.status, 400, `${label}: ${response.raw}`);
    assertErrorEnvelope(response, 'VALIDATION_ERROR');
  }
  assert.deepEqual(storedFiles(uploadDir), []);
});

test('files above 10 MB are refused with 413; exactly 10 MB is accepted', async (t) => {
  const { request, token, uploadDir, config, close } = await setup();
  t.after(close);
  assert.equal(config.storage.maxBytes, 10 * 1024 * 1024);

  const exact = Buffer.concat([SAMPLES.pdf, Buffer.alloc(config.storage.maxBytes - SAMPLES.pdf.length, 0x20)]);
  const accepted = await uploadFile(request, token, { bytes: exact });
  assert.equal(accepted.status, 201, accepted.raw);
  assert.equal(accepted.data.sizeBytes, config.storage.maxBytes);
  await settled(request, token, accepted.data.id);

  const tooBig = Buffer.concat([exact, Buffer.from(' ')]);
  assertRejected(await uploadFile(request, token, { bytes: tooBig }), 413, 'PAYLOAD_TOO_LARGE');
  const wayTooBig = Buffer.concat([exact, Buffer.alloc(2 * 1024 * 1024)]);
  assertRejected(await uploadFile(request, token, { bytes: wayTooBig }), 413, 'PAYLOAD_TOO_LARGE');
  assert.equal(storedFiles(uploadDir).length, 1, 'only the accepted file is stored');
});

test('unsafe filenames never reach the filesystem', async (t) => {
  const { request, token, uploadDir, close } = await setup();
  t.after(close);
  const names = {
    '../../../etc/passwd.pdf': 'passwd.pdf',
    '..\\..\\windows\\win.ini.pdf': 'win.ini.pdf',
    'C:\\Users\\victim\\scan.pdf': 'scan.pdf',
    '/absolute/path/receipt.pdf': 'receipt.pdf',
    'tab\there.pdf': 'tabhere.pdf',
  };
  for (const [unsafe, display] of Object.entries(names)) {
    const response = await uploadFile(request, token, { filename: unsafe });
    assert.equal(response.status, 201, `${unsafe}: ${response.raw}`);
    assert.equal(response.data.originalFilename, display);
    await settled(request, token, response.data.id);
  }
  for (const stored of storedFiles(uploadDir)) {
    assert.match(stored, /^cmp_[0-9A-Z]{26}\/doc_[0-9A-Z]{26}\.pdf$/);
  }
  assert.equal(fs.existsSync(path.join(uploadDir, '..', 'etc')), false);
});

// ---------------------------------------------------------------- lifecycle without a provider

test('without an AI provider the document fails truthfully as ai_unavailable, with nothing extracted', async (t) => {
  const { request, token, db, close } = await setup();
  t.after(close);
  const uploaded = await uploadFile(request, token);
  assert.equal(uploaded.data.status, 'processing', 'the upload responds before extraction');

  const response = await settled(request, token, uploaded.data.id);
  const document = response.data;
  assert.equal(document.status, 'failed');
  assert.equal(document.failure.code, 'ai_unavailable');
  assert.match(document.failure.message, /no AI provider is configured.*manually/);
  assert.deepEqual(
    { ...document.extraction, createdAt: 'x' },
    { attempt: 1, method: 'unavailable', provider: null, outcome: 'failed', fields: null, needsReview: null, createdAt: 'x' },
    'no invented fields, no invented confidence',
  );
  assert.deepEqual(response.meta.capability, {
    method: 'unavailable', confidence: null, degraded: true,
    note: 'Automated extraction is unavailable: no AI provider is configured. Enter the details manually.',
  });
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0, 'an upload never creates financial records');
});

test('re-running extraction without a provider is 503 AI_UNAVAILABLE and changes nothing', async (t) => {
  const { request, token, db, close } = await setup();
  t.after(close);
  const uploaded = await uploadFile(request, token);
  await settled(request, token, uploaded.data.id);

  const response = await request('POST', `/api/v1/documents/${uploaded.data.id}/extract`, { token });
  assertRejected(response, 503, 'AI_UNAVAILABLE');
  assert.match(response.error.message, /no AI provider is configured/);
  assert.equal(db.getValue('SELECT count(*) FROM document_extractions'), 1);
});

test('a configured provider name without an adapter is reported as unavailable, not faked', async (t) => {
  const app = await createDocumentsApp();
  t.after(app.close);
  // A provider configured by environment, but no adapter exists for it.
  const { createTestApp } = await import('./helpers/testApp.js');
  const configured = await createTestApp({ env: { UPLOAD_DIR: app.uploadDir, AI_PROVIDER: 'some-vendor', AI_API_KEY: 'k', AI_MODEL: 'm' } });
  t.after(configured.close);
  const { token } = await ownerWithCompany(configured.request, { email: 'o@a.example', companyName: 'A' });
  const uploaded = await uploadFile(configured.request, token);
  const document = (await settled(configured.request, token, uploaded.data.id)).data;
  assert.equal(document.failure.code, 'ai_unavailable');
  assert.match(document.failure.message, /no document reader exists for AI provider "some-vendor"/);
});

test('documents left processing by a stopped process are failed as interrupted on startup', async (t) => {
  const { request, token, db, config, close } = await setup();
  t.after(close);
  const uploaded = await uploadFile(request, token);
  await settled(request, token, uploaded.data.id);
  db.run("UPDATE documents SET status = 'processing', failure_code = NULL, failure_message = NULL");

  const { createServices } = await import('../src/services/index.js');
  createServices({ db, config });
  const document = (await request('GET', `/api/v1/documents/${uploaded.data.id}`, { token })).data;
  assert.equal(document.status, 'failed');
  assert.equal(document.failure.code, 'interrupted');
});

// ---------------------------------------------------------------- read, list, file, delete

test('the stored file is served only through its document, never as a path', async (t) => {
  const { request, token, baseUrl, close } = await setup();
  t.after(close);
  const uploaded = await uploadFile(request, token, { filename: 'Receipt; March <draft>.pdf' });
  await settled(request, token, uploaded.data.id);

  const response = await fetch(`${baseUrl}/api/v1/documents/${uploaded.data.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="document-${uploaded.data.id}.pdf"`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SAMPLES.pdf);

  for (const probe of [
    '/api/v1/documents/..%2F..%2Fpackage.json/file',
    '/api/v1/documents/../../package.json/file',
    '/api/v1/documents/file?path=../../package.json',
    '/api/v1/files?path=../../package.json',
    `/api/v1/documents/${uploaded.data.id}/file/../../../package.json`,
  ]) {
    const attempt = await fetch(`${baseUrl}${probe}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await attempt.text();
    assert.ok(attempt.status === 404 || attempt.status === 400, `${probe}: ${attempt.status}`);
    assert.ok(!text.includes('"name"') && !text.includes('ifrsmart-backend'), `${probe} served a file`);
  }

  assert.equal((await fetch(`${baseUrl}/api/v1/documents/${uploaded.data.id}/file`)).status, 401);
});

test('documents are listed with pagination and a status filter', async (t) => {
  const { request, token, close } = await setup();
  t.after(close);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const uploaded = await uploadFile(request, token, { filename: `r${i}.pdf` });
    await settled(request, token, uploaded.data.id);
    ids.push(uploaded.data.id);
  }
  const first = await request('GET', '/api/v1/documents?limit=2', { token });
  assert.deepEqual(first.meta, { page: 1, limit: 2, total: 3, totalPages: 2, hasNext: true, hasPrevious: false, sort: 'createdAt:desc' });
  assert.equal('extraction' in first.data[0], false, 'the list omits extraction details');
  const second = await request('GET', '/api/v1/documents?limit=2&page=2', { token });
  assert.deepEqual([...first.data, ...second.data].map((d) => d.id).sort(), [...ids].sort());
  assert.equal((await request('GET', '/api/v1/documents?status=failed', { token })).meta.total, 3);
  assert.equal((await request('GET', '/api/v1/documents?status=ready', { token })).meta.total, 0);
  for (const bad of ['status=done', 'sort=name', 'limit=0']) {
    assertRejected(await request('GET', `/api/v1/documents?${bad}`, { token }), 400, 'VALIDATION_ERROR');
  }
});

test('an unconfirmed document is deleted with its extractions and file', async (t) => {
  const { request, token, uploadDir, db, close } = await setup();
  t.after(close);
  const uploaded = await uploadFile(request, token);
  await settled(request, token, uploaded.data.id);
  assert.equal(storedFiles(uploadDir).length, 1);

  const deleted = await request('DELETE', `/api/v1/documents/${uploaded.data.id}`, { token });
  assert.equal(deleted.status, 204);
  assert.deepEqual(storedFiles(uploadDir), []);
  assert.equal(db.getValue('SELECT count(*) FROM documents'), 0);
  assert.equal(db.getValue('SELECT count(*) FROM document_extractions'), 0);
  assertRejected(await request('GET', `/api/v1/documents/${uploaded.data.id}`, { token }), 404, 'NOT_FOUND');
  assertRejected(await request('DELETE', `/api/v1/documents/${uploaded.data.id}`, { token }), 404, 'NOT_FOUND');
  assertRejected(await request('GET', '/api/v1/documents/garbage', { token }), 404, 'NOT_FOUND');
});

test('document routes require a session and a company', async (t) => {
  const { request, close } = await createDocumentsApp();
  t.after(close);
  for (const [method, path_] of [
    ['GET', '/api/v1/documents'], ['GET', '/api/v1/documents/doc_01M3EFNC4TMGZ36SQ8D1WYJ2TK'],
    ['GET', '/api/v1/documents/doc_01M3EFNC4TMGZ36SQ8D1WYJ2TK/file'], ['DELETE', '/api/v1/documents/doc_01M3EFNC4TMGZ36SQ8D1WYJ2TK'],
  ]) {
    assert.equal((await request(method, path_)).status, 401, `${method} ${path_}`);
  }
  assert.equal((await uploadFile(request, undefined)).status, 401);
});
