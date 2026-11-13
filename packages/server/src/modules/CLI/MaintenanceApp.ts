import type { INestApplication } from '@nestjs/common';

/**
 * Boots the application (this code, not a running server) for a
 * maintenance command, without the work a server does on its own: no
 * startup cash basis rebuild and no queue workers. Otherwise a dry run
 * could start ledger rebuilds or run queued jobs of any organization while
 * it says nothing was changed.
 *
 * The imports use relative paths: the build doesn't rewrite the `@/` alias
 * inside dynamic imports, so `node dist/cli.js` couldn't load an aliased one.
 * @returns {Promise<INestApplication>} The initialized app; close it after use.
 */
export const createMaintenanceApp = async (): Promise<INestApplication> => {
  // Read by CashBasisAutoRebuildService when the app starts.
  process.env.CASH_BASIS_AUTO_REBUILD = 'false';

  const { NestFactory } = await import('@nestjs/core');
  const { BULL_EXTRA_OPTIONS_TOKEN } = await import(
    '@nestjs/bullmq/dist/bull.constants'
  );
  const { AppModule } = await import('../App/App.module');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  // The queue workers register on init unless registration is manual: the
  // command only adds jobs (if any) for the server's workers to run.
  const bullExtraOptions = app.get(BULL_EXTRA_OPTIONS_TOKEN, {
    strict: false,
  });
  bullExtraOptions.manualRegistration = true;

  await app.init();

  // The commands close the app and exit right after their last save: let
  // that save's after-commit work (for example adding the cost recompute
  // job) finish first, or it is cut off.
  const { settleAfterCommitWork } = await import(
    '../Tenancy/TenancyDB/TransactionsHooks'
  );
  const close = app.close.bind(app);
  app.close = async () => {
    await settleAfterCommitWork();
    return close();
  };
  return app;
};
