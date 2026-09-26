/**
 * Documents and the AI invoice/receipt reader (PRODUCT_REQUIREMENTS.md #10,
 * API_CONTRACT.md §9.7).
 *
 *   upload ──▶ file stored, document 'processing' ──▶ extraction (after the
 *   response, in this process) ──▶ 'ready' (fields to review) | 'failed'
 *
 * - Extraction never writes a financial record. Only confirmation — the
 *   user's reviewed values — creates a transaction (through the ledger
 *   service) or a draft invoice (through the invoice service), and links it
 *   to the document. The financial engine stays the only source of figures.
 * - With no AI provider the document fails with 'ai_unavailable' and the user
 *   enters the details manually; nothing is invented.
 * - No queue: extraction runs in the Node process after the upload response.
 *   Documents a stopped process left 'processing' are failed as 'interrupted'
 *   when the service starts, so none stays stuck.
 */

import { AppError, conflict, notFound, unprocessable, unsupportedMediaType } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIsoTimestamp } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { UPLOAD_TYPES, detectMimeType, displayFilename, extensionOf } from '../lib/fileTypes.js';
import { storageKeyFor } from '../storage/localStorage.js';
import { ExtractionFailure, fieldsNeedingReview } from '../ai/documentReader.js';
import * as documents from '../models/documents.js';
import * as companies from '../models/companies.js';

const INTERRUPTED_MESSAGE = 'Extraction was interrupted by a server restart. Re-run it or enter the details manually.';
const INTERNAL_FAILURE = new ExtractionFailure('internal_error', 'Extraction failed unexpectedly. Re-run it or enter the details manually.');

export function createDocumentService({ db, config, storage, reader, ledger, invoices }) {
  documents.failInterruptedDocuments(db, INTERRUPTED_MESSAGE, nowIsoTimestamp());

  function requireDocument(companyId, documentId) {
    const document = documents.findDocument(db, companyId, documentId);
    if (!document) throw notFound('Document not found.');
    return document;
  }

  function present(companyId, document, { withExtraction = true } = {}) {
    const presented = {
      id: document.id,
      status: document.status,
      originalFilename: document.originalFilename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      failure: document.failureCode ? { code: document.failureCode, message: document.failureMessage } : null,
      confirmation: document.confirmedAt
        ? { target: document.confirmedTarget, transactionId: document.transactionId, invoiceId: document.invoiceId, confirmedAt: document.confirmedAt }
        : null,
      processedAt: document.processedAt,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
    if (withExtraction) {
      const extraction = documents.latestExtraction(db, companyId, document.id);
      const { currency } = companies.getCompany(db, companyId);
      presented.extraction = extraction
        ? {
          attempt: extraction.attempt,
          method: extraction.method,
          provider: extraction.provider,
          outcome: extraction.outcome,
          fields: extraction.fields,
          needsReview: extraction.fields ? fieldsNeedingReview(extraction.fields, currency) : null,
          createdAt: extraction.createdAt,
        }
        : null;
    }
    return presented;
  }

  /** Capability disclosure (API_CONTRACT.md §3.1) for a document response. */
  function capability(presented) {
    const current = reader.capability();
    const method = presented.extraction?.method ?? current.method;
    return {
      method,
      // Confidence is per field (extraction.fields.*.confidence), not overall.
      confidence: null,
      degraded: method === 'unavailable',
      note: method === 'unavailable' ? current.note : null,
    };
  }

  function respond(companyId, document) {
    const presented = present(companyId, document);
    return { data: presented, meta: { capability: capability(presented) } };
  }

  async function extract(companyId, documentId) {
    const document = documents.findDocument(db, companyId, documentId);
    if (!document || document.status !== 'processing') return;

    let result;
    try {
      const bytes = await storage.read(document.storageKey);
      if (!bytes) throw INTERNAL_FAILURE;
      const { provider, fields } = await reader.read({ bytes, mimeType: document.mimeType });
      result = { status: 'ready', method: 'ai', provider, outcome: 'succeeded', fields, failure: null };
    } catch (error) {
      if (!(error instanceof ExtractionFailure)) throw error;
      result = {
        status: 'failed',
        method: error.code === 'ai_unavailable' ? 'unavailable' : 'ai',
        provider: reader.capability().provider,
        outcome: 'failed',
        fields: null,
        failure: error,
      };
    }

    const now = nowIsoTimestamp();
    db.transaction(() => {
      // A document deleted (or already finished) meanwhile is left alone.
      const finished = documents.finishProcessing(db, companyId, documentId, {
        status: result.status, failureCode: result.failure?.code ?? null, failureMessage: result.failure?.message ?? null, now,
      });
      if (!finished) return;
      documents.insertExtraction(db, companyId, {
        id: newId('dex'), documentId, method: result.method, provider: result.provider,
        outcome: result.outcome, fields: result.fields, failureCode: result.failure?.code ?? null, now,
      });
    });
  }

  /** Run extraction after the current request; never leaves a document stuck. */
  function schedule(companyId, documentId) {
    setImmediate(() => {
      extract(companyId, documentId).catch((error) => {
        logger.error('document extraction failed unexpectedly', { documentId, error });
        try {
          documents.finishProcessing(db, companyId, documentId, {
            status: 'failed', failureCode: INTERNAL_FAILURE.code, failureMessage: INTERNAL_FAILURE.message, now: nowIsoTimestamp(),
          });
        } catch {
          // The database is unusable (e.g. closed); startup recovery will fail it.
        }
      });
    });
  }

  return {
    /**
     * Store an upload and start extraction.
     * @param {{ bytes: Uint8Array, declaredType: string, filename: string }} upload
     */
    async upload(companyId, { bytes, declaredType, filename }) {
      const detected = detectMimeType(bytes);
      if (!detected || !config.storage.allowedMimeTypes.includes(detected)) {
        throw unsupportedMediaType('Upload a PDF or an image (JPEG, PNG, WebP, GIF or HEIC).');
      }
      if (declaredType !== detected) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The file content does not match its declared type.', [
          { field: 'file', issue: `declared ${declaredType || 'no type'} but the content is ${detected}` },
        ]);
      }
      const extension = extensionOf(filename);
      if (extension && !UPLOAD_TYPES[detected].extensions.includes(extension)) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The file extension does not match its content.', [
          { field: 'file', issue: `.${extension} does not match ${detected}` },
        ]);
      }

      const id = newId('doc');
      const storageKey = storageKeyFor(companyId, id, UPLOAD_TYPES[detected].storedExtension);
      await storage.save(storageKey, bytes);
      try {
        documents.insertDocument(db, companyId, {
          id, originalFilename: displayFilename(filename), storageKey, mimeType: detected, sizeBytes: bytes.length, now: nowIsoTimestamp(),
        });
      } catch (error) {
        await storage.remove(storageKey);
        throw error;
      }
      const response = respond(companyId, requireDocument(companyId, id));
      schedule(companyId, id);
      return response;
    },

    list(companyId, query) {
      const { items, total } = documents.listDocuments(db, companyId, {
        statuses: query.status, sort: query.sort, page: query.page, limit: query.limit,
      });
      return { items: items.map((document) => present(companyId, document, { withExtraction: false })), total };
    },

    get(companyId, documentId) {
      return respond(companyId, requireDocument(companyId, documentId));
    },

    /** The stored file, resolved from the company's own document record only. */
    async file(companyId, documentId) {
      const document = requireDocument(companyId, documentId);
      const bytes = await storage.read(document.storageKey);
      if (!bytes) throw notFound('The stored file is missing.');
      return { bytes, mimeType: document.mimeType, filename: `document-${document.id}.${UPLOAD_TYPES[document.mimeType].storedExtension}` };
    },

    /** Re-run extraction (a new attempt). Needs an available reader. */
    rerun(companyId, documentId) {
      // Existence first: another company's document is a 404 whatever the
      // provider state, exactly like a document that does not exist.
      const document = requireDocument(companyId, documentId);
      const current = reader.capability();
      if (!current.available) throw new AppError('AI_UNAVAILABLE', current.note);
      if (document.status === 'processing') throw conflict('The document is already being processed.');
      if (document.confirmedAt) throw unprocessable('A confirmed document cannot be re-extracted.', [{ field: 'status', issue: 'document is confirmed' }]);
      documents.restartProcessing(db, companyId, documentId, nowIsoTimestamp());
      const response = respond(companyId, requireDocument(companyId, documentId));
      schedule(companyId, documentId);
      return response;
    },

    /**
     * Create the reviewed record from a document: a transaction (source
     * 'document') or a draft invoice, linked to the document, atomically.
     * The body carries the values the user reviewed, validated exactly like
     * POST /transactions or POST /invoices.
     */
    confirm(companyId, documentId, input) {
      return db.transaction(() => {
        const document = requireDocument(companyId, documentId);
        if (document.status === 'processing') throw conflict('The document is still being processed.');
        if (document.confirmedAt) throw conflict('The document is already confirmed.', [{ field: 'status', issue: `confirmed as ${document.confirmedTarget}` }]);
        const now = nowIsoTimestamp();

        if (input.target === 'transaction') {
          const { transaction, possibleDuplicateOf } = ledger.createTransaction(companyId, input.transaction);
          documents.markTransactionFromDocument(db, companyId, transaction.id);
          documents.confirmDocument(db, companyId, documentId, { target: 'transaction', transactionId: transaction.id, now });
          const result = {
            data: { document: present(companyId, requireDocument(companyId, documentId)), transaction: ledger.getTransaction(companyId, transaction.id) },
          };
          if (possibleDuplicateOf.length > 0) result.meta = { possibleDuplicateOf };
          return result;
        }

        const invoice = invoices.createInvoice(companyId, input.invoice);
        documents.confirmDocument(db, companyId, documentId, { target: 'invoice', invoiceId: invoice.id, now });
        return { data: { document: present(companyId, requireDocument(companyId, documentId)), invoice } };
      });
    },

    /** Delete an unconfirmed document, its extractions and its stored file. */
    async remove(companyId, documentId) {
      const document = requireDocument(companyId, documentId);
      if (document.confirmedAt) {
        throw unprocessable('A confirmed document cannot be deleted.', [{ field: 'status', issue: `confirmed as ${document.confirmedTarget}` }]);
      }
      documents.deleteDocument(db, companyId, documentId);
      await storage.remove(document.storageKey);
    },
  };
}
