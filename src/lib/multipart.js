/**
 * Single-file multipart/form-data upload parsing with Node built-ins only:
 * the body is read with a hard size ceiling, then parsed by the WHATWG
 * `Response.formData()` implementation that ships with Node. No dependency.
 *
 * Contract of an upload request: exactly one part, named "file", carrying a
 * file. Anything else is a VALIDATION_ERROR.
 */

import { AppError, badRequest, payloadTooLarge } from './errors.js';

/** Room for the multipart boundaries and part headers around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** After rejecting an oversized body, how much more is drained before giving up. */
const MAX_DISCARD_BYTES = 8 * 1024 * 1024;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      // Drain rather than destroy, so the client can read the error response.
      req.bodyAbandoned = true;
      req.resume();
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (settled) {
        if (size > maxBytes + MAX_DISCARD_BYTES) req.destroy();
        return;
      }
      if (size > maxBytes) {
        fail(payloadTooLarge('The upload is larger than the allowed maximum.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => fail(badRequest('Could not read the upload.')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * @returns {Promise<{ bytes: Uint8Array, declaredType: string, filename: string }>}
 */
export async function readSingleFileUpload(req, { maxFileBytes }) {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload the file as multipart/form-data.');
  }

  // The size is enforced while streaming (not from Content-Length alone), so
  // the excess is drained and the client can still read the 413.
  const body = await readBody(req, maxFileBytes + MULTIPART_OVERHEAD_BYTES);

  let form;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw badRequest('The multipart body is malformed.', [{ field: 'file', issue: 'malformed multipart/form-data' }]);
  }

  const entries = [...form.entries()];
  const file = form.get('file');
  if (entries.length !== 1 || typeof file === 'string' || file === null) {
    throw badRequest('Send exactly one part, named "file", containing the document.', [
      { field: 'file', issue: 'exactly one file part named "file" is required' },
    ]);
  }
  if (file.size === 0) {
    throw badRequest('The uploaded file is empty.', [{ field: 'file', issue: 'must not be empty' }]);
  }
  if (file.size > maxFileBytes) {
    throw payloadTooLarge('The file is larger than the allowed maximum.');
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), declaredType: file.type, filename: file.name };
}
