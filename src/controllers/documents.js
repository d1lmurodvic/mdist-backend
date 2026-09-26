/**
 * Document controllers — HTTP only: multipart reading, the file download, and
 * response shaping. The company is always req.tenant.companyId.
 */

import { notFound } from '../lib/errors.js';
import { readSingleFileUpload } from '../lib/multipart.js';
import { idSchema, parseOrThrow } from '../lib/validate.js';

function pathId(req) {
  const result = idSchema.safeParse(req.params.documentId);
  if (!result.success) throw notFound('Document not found.');
  return result.data;
}

function queryObject(searchParams, repeatable = []) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    query[key] = repeatable.includes(key) ? searchParams.getAll(key) : searchParams.get(key);
  }
  return query;
}

export function createDocumentController({ services, config, schemas }) {
  const { documents } = services;

  return {
    async upload(req) {
      const upload = await readSingleFileUpload(req, { maxFileBytes: config.storage.maxBytes });
      const { data, meta } = await documents.upload(req.tenant.companyId, upload);
      return { status: 201, headers: { Location: `/api/v1/documents/${data.id}` }, data, meta };
    },

    list(req) {
      const query = parseOrThrow(schemas.documentListQuery, queryObject(req.searchParams, ['status']));
      const { items, total } = documents.list(req.tenant.companyId, query);
      const totalPages = Math.max(1, Math.ceil(total / query.limit));
      return {
        data: items,
        meta: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
          hasNext: query.page < totalPages,
          hasPrevious: query.page > 1,
          sort: `${query.sort.field}:${query.sort.direction}`,
        },
      };
    },

    get(req) {
      return documents.get(req.tenant.companyId, pathId(req));
    },

    /** The stored bytes, with headers that stop the browser from sniffing or caching them. */
    async file(req, res) {
      const { bytes, mimeType, filename } = await documents.file(req.tenant.companyId, pathId(req));
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': bytes.length,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      res.end(bytes);
    },

    extract(req) {
      return documents.rerun(req.tenant.companyId, pathId(req));
    },

    confirm(req) {
      const { data, meta } = documents.confirm(req.tenant.companyId, pathId(req), req.validBody);
      return { status: 201, data, meta };
    },

    async remove(req) {
      await documents.remove(req.tenant.companyId, pathId(req));
      return { status: 204 };
    },
  };
}
