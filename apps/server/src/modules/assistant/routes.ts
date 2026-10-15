import { askBody } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { asUser, requireUser } from '../../plugins/access';
import { ask, assistantStatus } from './service';

export const assistantRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/assistant/status', { config: asUser('viewer') }, async (req) => assistantStatus(deps, requireUser(req) as Parameters<typeof assistantStatus>[1]));

    // POST, но данные не меняет: вопрос в теле, чтобы он не попадал в адрес и журналы доступа
    app.post(
      '/assistant/ask',
      { config: { ...asUser('viewer'), rateLimit: { max: deps.config.assistantRateLimit, timeWindow: '1 minute' } }, schema: { body: askBody } },
      async (req) => ask(deps, requireUser(req), req.body, req.meta),
    );
  };
