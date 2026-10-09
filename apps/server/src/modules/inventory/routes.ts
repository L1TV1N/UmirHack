import { createInventoryBody, idParam, idempotencyKey, inventoriesQuery, inventoryLinesBody } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../lib/context';
import { asUser, requireUser } from '../../plugins/access';
import {
  cancelInventory,
  commitInventory,
  createInventory,
  getInventory,
  listInventories,
  saveLines,
} from './service';

export const inventoryRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const actor = (req: Parameters<typeof requireUser>[0]) => ({ principal: requireUser(req), meta: req.meta });

    app.get('/inventories', { config: asUser(), schema: { querystring: inventoriesQuery } }, async (req) =>
      listInventories(deps, requireUser(req), req.query),
    );

    app.get('/inventories/:id', { config: asUser(), schema: { params: idParam } }, async (req) =>
      getInventory(deps, requireUser(req), req.params.id),
    );

    app.post('/inventories', { config: asUser('storekeeper'), schema: { body: createInventoryBody } }, async (req, reply) => {
      const id = await createInventory(deps, actor(req), req.body);
      return reply.status(201).send(await getInventory(deps, requireUser(req), id));
    });

    app.put(
      '/inventories/:id/lines',
      { config: asUser('storekeeper'), schema: { params: idParam, body: inventoryLinesBody } },
      async (req) => {
        await saveLines(deps, actor(req), req.params.id, req.body);
        return getInventory(deps, requireUser(req), req.params.id);
      },
    );

    app.post(
      '/inventories/:id/commit',
      {
        config: asUser('manager'),
        schema: { params: idParam, headers: z.object({ 'idempotency-key': idempotencyKey.optional() }) },
      },
      async (req) => {
        const result = await commitInventory(deps, actor(req), req.params.id, req.headers['idempotency-key']);
        return { ...result, inventory: await getInventory(deps, requireUser(req), req.params.id) };
      },
    );

    app.post('/inventories/:id/cancel', { config: asUser('storekeeper'), schema: { params: idParam } }, async (req) => {
      await cancelInventory(deps, actor(req), req.params.id);
      return getInventory(deps, requireUser(req), req.params.id);
    });
  };
