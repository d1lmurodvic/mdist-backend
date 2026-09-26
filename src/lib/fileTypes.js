/**
 * Upload type detection by file signature ("magic bytes").
 *
 * The client's Content-Type and filename are claims; the bytes are evidence.
 * An upload is accepted only when its signature is one of the approved types
 * (config.storage.allowedMimeTypes) AND agrees with the declared MIME type and
 * the filename extension, so a renamed executable cannot pass as a PDF.
 */

/** mimeType -> { extensions it may carry, the extension it is stored with }. */
export const UPLOAD_TYPES = Object.freeze({
  'application/pdf': { extensions: ['pdf'], storedExtension: 'pdf' },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], storedExtension: 'jpg' },
  'image/png': { extensions: ['png'], storedExtension: 'png' },
  'image/webp': { extensions: ['webp'], storedExtension: 'webp' },
  'image/gif': { extensions: ['gif'], storedExtension: 'gif' },
  'image/heic': { extensions: ['heic', 'heif'], storedExtension: 'heic' },
});

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** The MIME type the bytes actually are, or null when unrecognised. */
export function detectMimeType(bytes) {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 12))) return 'image/heic';
  return null;
}

/** Lower-case extension of a filename, or null. */
export function extensionOf(filename) {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename ?? '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * The filename a user gave, reduced to a display label: no directory parts,
 * no control characters, at most 255 characters. It is metadata only and is
 * never used to build a filesystem path.
 */
export function displayFilename(name) {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean === '' || clean === '.' || clean === '..' ? null : clean;
}
