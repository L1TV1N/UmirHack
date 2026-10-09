import {
  batchesQuery,
  documentsQuery,
  idParam,
  idempotencyKey,
  movementsQuery,
  posSaleBody,
  receiptBody,
  saleBody,
  stockSummaryQuery,
  transferBody,
  writeoffBody,
  writeoffExpiredBody,
} from '@zapas/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Actor, Deps } from '../../lib/context';
import { forbidden } from '../../lib/errors';
import { locationFilter } from '../../lib/scope';
import { asPos, asUser, requirePrincipal } from '../../plugins/access';
import { getBatch, getDocument, listBatches, listDocuments, listMovements, stockSummary } from './queries';
import { receive, sell, transfer, writeOff, writeOffExpired, type DocResult } from './operations';

const idemHeaders = z.object({ 'idempotency-key': idempotencyKey.optional() });

export const stockRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const actor = (req: FastifyRequest): Actor => ({ principal: requirePrincipal(req), meta: req.meta });
    const created = (reply: FastifyReply, result: DocResult) => reply.status(result.duplicate ? 200 : 201).send(result);

    app.get('/stock/summary', { config: asUser(), schema: { querystring: stockSummaryQuery } }, async (req) => {
      const { locationId, ...rest } = req.query;
      return stockSummary(deps, { ...rest, locationIds: locationFilter(requirePrincipal(req), locationId) });
    });

    app.get('/stock/batches', { config: asUser(), schema: { querystring: batchesQuery } }, async (req) => {
      const { locationId, ...rest } = req.query;
      return listBatches(deps, { ...rest, locationIds: locationFilter(requirePrincipal(req), locationId) });
    });

    app.get('/stock/batches/:id', { config: asUser(), schema: { params: idParam } }, async (req) =>
      getBatch(deps, req.params.id, locationFilter(requirePrincipal(req))),
    );

    app.get('/stock/movements', { config: asUser(), schema: { querystring: movementsQuery } }, async (req) => {
      const { locationId, ...rest } = req.query;
      return listMovements(deps, { ...rest, locationIds: locationFilter(requirePrincipal(req), locationId) });
    });

    app.get('/documents', { config: asUser(), schema: { querystring: documentsQuery } }, async (req) => {
      const { locationId, ...rest } = req.query;
      return listDocuments(deps, { ...rest, locationIds: locationFilter(requirePrincipal(req), locationId) });
    });

    app.get('/documents/:id', { config: asUser(), schema: { params: idParam } }, async (req) =>
      getDocument(deps, req.params.id, locationFilter(requirePrincipal(req))),
    );

    app.post(
      '/documents/receipts',
      { config: asUser('storekeeper'), schema: { body: receiptBody, headers: idemHeaders } },
      async (req, reply) => created(reply, await receive(deps, actor(req), req.body, req.headers['idempotency-key'])),
    );

    app.post(
      '/documents/sales',
      { config: asUser('storekeeper'), schema: { body: saleBody, headers: idemHeaders } },
      async (req, reply) => created(reply, await sell(deps, actor(req), req.body, req.headers['idempotency-key'])),
    );

    app.post(
      '/documents/writeoffs',
      { config: asUser('storekeeper'), schema: { body: writeoffBody, headers: idemHeaders } },
      async (req, reply) => created(reply, await writeOff(deps, actor(req), req.body, req.headers['idempotency-key'])),
    );

    app.post(
      '/documents/writeoffs/expired',
      { config: asUser('storekeeper'), schema: { body: writeoffExpiredBody, headers: idemHeaders } },
      async (req, reply) => created(reply, await writeOffExpired(deps, actor(req), req.body, req.headers['idempotency-key'])),
    );

    app.post(
      '/documents/transfers',
      { config: asUser('storekeeper'), schema: { body: transferBody, headers: idemHeaders } },
      async (req, reply) => created(reply, await transfer(deps, actor(req), req.body, req.headers['idempotency-key'])),
    );

    app.post('/pos/sales', { config: asPos, schema: { body: posSaleBody } }, async (req, reply) => {
      const principal = requirePrincipal(req);
      const locationId = principal.locationIds === 'all' ? undefined : principal.locationIds[0];
      if (principal.kind !== 'apikey' || !locationId) throw forbidden();
      const result = await sell(deps, { principal, meta: req.meta }, { locationId, lines: req.body.lines }, req.body.externalId);
      return created(reply, result);
    });
  };
