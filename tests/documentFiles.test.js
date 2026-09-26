/**
 * Phase 5 file handling units: signature detection, filename handling, the
 * storage key guard, and the document reader's capability and review rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectMimeType, displayFilename, extensionOf } from '../src/lib/fileTypes.js';
import { createLocalStorage, storageKeyFor } from '../src/storage/localStorage.js';
import { createDocumentReader, fieldsNeedingReview, ExtractionFailure } from '../src/ai/documentReader.js';
import { SAMPLES, providerResult } from './helpers/documents.js';

const CMP = 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK';
const DOC = 'doc_01M3EFNC4TMGZ36SQ8D1WYJ2TK';

test('file types are recognised from their bytes, not their names', () => {
  assert.equal(detectMimeType(SAMPLES.pdf), 'application/pdf');
  assert.equal(detectMimeType(SAMPLES.png), 'image/png');
  assert.equal(detectMimeType(SAMPLES.jpeg), 'image/jpeg');
  assert.equal(detectMimeType(SAMPLES.webp), 'image/webp');
  assert.equal(detectMimeType(SAMPLES.gif), 'image/gif');
  assert.equal(detectMimeType(SAMPLES.heic), 'image/heic');
  assert.equal(detectMimeType(SAMPLES.exe), null);
  assert.equal(detectMimeType(SAMPLES.text), null);
  assert.equal(detectMimeType(new Uint8Array([0x25, 0x50, 0x44])), null, 'a truncated signature is not enough');
  assert.equal(detectMimeType(new Uint8Array()), null);
  assert.equal(detectMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'SVG (scriptable) is not accepted');
});

test('filenames are reduced to a display label and never to a path', () => {
  assert.equal(displayFilename('../../etc/passwd'), 'passwd');
  assert.equal(displayFilename('..\\..\\Windows\\win.ini'), 'win.ini');
  assert.equal(displayFilename('a\u0000b\u001f.pdf'), 'ab.pdf');
  assert.equal(displayFilename('..'), null);
  assert.equal(displayFilename('dir/'), null);
  assert.equal(displayFilename('   '), null);
  assert.equal(displayFilename(undefined), null);
  assert.equal(displayFilename('x'.repeat(300)).length, 255);
  assert.equal(extensionOf('Receipt.PDF'), 'pdf');
  assert.equal(extensionOf('invoice.pdf.exe'), 'exe');
  assert.equal(extensionOf('noext'), null);
});

test('storage keys are server-shaped and cannot leave the upload directory', async (t) => {
  // The upload root sits inside a private parent, so an escape is observable
  // and cleaned up with it.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ifrsmart-storage-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'uploads');
  fs.mkdirSync(root);
  const storage = createLocalStorage({ rootDir: root });

  const key = storageKeyFor(CMP, DOC, 'pdf');
  assert.equal(key, `${CMP}/${DOC}.pdf`);
  for (const [company, document, ext] of [['../x', DOC, 'pdf'], [CMP, '../../x', 'pdf'], [CMP, DOC, 'exe'], [CMP, DOC, 'pdf/../../x']]) {
    assert.throws(() => storageKeyFor(company, document, ext), /invalid storage key/);
  }

  const outside = path.join(parent, 'outside.pdf');
  for (const bad of ['../outside.pdf', `${CMP}/../../outside.pdf`, outside, `${CMP}\\..\\..\\outside.pdf`, `${CMP}/${DOC}.pdf/..`, '']) {
    await assert.rejects(storage.save(bad, SAMPLES.pdf), /Invalid storage key|escapes/, bad);
    await assert.rejects(storage.read(bad), /Invalid storage key|escapes/, bad);
    await assert.rejects(storage.remove(bad), /Invalid storage key|escapes/, bad);
  }
  assert.equal(fs.existsSync(outside), false);

  await storage.save(key, SAMPLES.pdf);
  await assert.rejects(storage.save(key, SAMPLES.png), /EEXIST/, 'an existing file is never overwritten');
  assert.deepEqual(await storage.read(key), SAMPLES.pdf);
  await storage.remove(key);
  assert.equal(await storage.read(key), null);
  await storage.remove(key);
});

test('the reader states truthfully when no provider can read documents', async () => {
  const none = createDocumentReader({ config: { ai: { enabled: false, provider: null } } });
  assert.deepEqual(none.capability(), {
    available: false, method: 'unavailable', provider: null,
    note: 'Automated extraction is unavailable: no AI provider is configured. Enter the details manually.',
  });
  await assert.rejects(none.read({ bytes: SAMPLES.pdf, mimeType: 'application/pdf' }),
    (error) => error instanceof ExtractionFailure && error.code === 'ai_unavailable');

  const unknown = createDocumentReader({ config: { ai: { enabled: true, provider: 'some-vendor', apiKey: 'k', model: 'm' } } });
  assert.equal(unknown.capability().available, false);
  assert.match(unknown.capability().note, /no document reader exists for AI provider "some-vendor"/);
});

test('review flags cover missing, low-confidence and wrong-currency fields', () => {
  const { readable, ...fields } = providerResult({
    subtotal: { value: { amount: 100, currency: 'UZS' }, confidence: 0.79 },
    tax: { value: { amount: 12, currency: 'UZS' }, confidence: 0.8 },
    total: { value: { amount: 112, currency: 'EUR' }, confidence: 0.99 },
  });
  assert.equal(readable, true);
  const flags = fieldsNeedingReview(fields, 'UZS');
  assert.ok(flags.some((f) => f.field === 'subtotal' && f.reason === 'low_confidence'), 'below the 0.8 threshold');
  assert.ok(!flags.some((f) => f.field === 'tax'), 'exactly at the threshold is accepted');
  assert.ok(flags.some((f) => f.field === 'total' && f.reason === 'currency_mismatch'));
  assert.ok(flags.some((f) => f.field === 'customer' && f.reason === 'missing'));
});
