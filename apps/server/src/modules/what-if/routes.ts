import { whatIfBody } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { asUser, requireUser } from '../../plugins/access';
import { runWhatIf } from './service';

export const whatIfRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // POST только потому, что сценарий велик для строки запроса; состояние сервера он не меняет
    app.post(
      '/analytics/what-if',
      { config: { ...asUser('storekeeper'), rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { body: whatIfBody } },
      async (req) => runWhatIf(deps, requireUser(req), req.body),
    );
  };
