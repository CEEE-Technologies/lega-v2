import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { DryRunRollback } from '@/modules/Tenancy/TenancyDB/DryRun';
import { ImportAls } from '@/modules/Import/ImportALS';
import { SaleInvoicesCost } from '@/modules/SaleInvoices/SalesInvoicesCost';
import { InventoryItemsQuantitySyncService } from '../commands/InventoryItemsQuantitySync.service';
import { InventoryComputeCostService } from '../commands/InventoryComputeCost.service';
import { InventoryCostSubscriber } from './InventoryCost.subscriber';

/**
 * E2 / E7: the item cost job and the "cost computing" flag only follow a
 * save that is committed. A dry run, an import preview or a failed save
 * schedules no job and leaves the flag off.
 */
describe('InventoryCostSubscriber', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  let emitter: EventEmitter2;
  let saleInvoicesCost: {
    computeItemsCostByInventoryTransactions: jest.Mock;
    scheduleComputeCostByInventoryTransactions: jest.Mock;
  };
  let computeCost: { markItemsCostComputeRunning: jest.Mock };
  let importAls: { isImportPreview: boolean };
  let calls: string[];

  beforeEach(async () => {
    calls = [];
    saleInvoicesCost = {
      computeItemsCostByInventoryTransactions: jest.fn(async () => {
        calls.push('schedule');
      }),
      scheduleComputeCostByInventoryTransactions: jest.fn(async () => {
        calls.push('schedule');
      }),
    };
    computeCost = {
      markItemsCostComputeRunning: jest.fn(async (running: boolean) => {
        calls.push(`flag:${running}`);
      }),
    };
    importAls = { isImportPreview: false };

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        InventoryCostSubscriber,
        { provide: SaleInvoicesCost, useValue: saleInvoicesCost },
        {
          provide: InventoryItemsQuantitySyncService,
          useValue: {
            getItemsQuantityChanges: () => [],
            getReverseItemsQuantityChanges: () => [],
            changeItemsQuantity: async () => undefined,
          },
        },
        { provide: InventoryComputeCostService, useValue: computeCost },
        { provide: ImportAls, useValue: importAls },
      ],
    }).compile();
    await moduleRef.init();
    emitter = moduleRef.get(EventEmitter2);
  });

  const fakeTrx = () => {
    let resolve: () => void;
    let reject: (e: Error) => void;
    const executionPromise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Like knex: a rollback nobody waits for is not an unhandled rejection.
    executionPromise.catch(() => undefined);
    return {
      trx: { executionPromise } as any,
      commit: () => resolve(),
      rollback: (e: Error) => reject(e),
    };
  };

  const movements = [{ itemId: 7, date: '2026-03-01' }];

  const created = (trx: any) =>
    emitter.emitAsync(events.inventory.onInventoryTransactionsCreated, {
      inventoryTransactions: movements,
      trx,
    });

  const deleted = (trx: any) =>
    emitter.emitAsync(events.inventory.onInventoryTransactionsDeleted, {
      transactionType: 'SaleInvoice',
      transactionId: 1,
      oldInventoryTransactions: movements,
      trx,
    });

  it('schedules nothing and leaves the flag off in a dry run', async () => {
    const { trx, rollback } = fakeTrx();
    await created(trx);
    await deleted(trx);
    rollback(new DryRunRollback());
    await flush();

    expect(calls).toEqual([]);
  });

  it('schedules nothing and leaves the flag off when the save fails', async () => {
    const { trx, rollback } = fakeTrx();
    await created(trx);
    rollback(new Error('a later handler failed'));
    await flush();

    expect(calls).toEqual([]);
  });

  it('schedules nothing and leaves the flag off in an import preview', async () => {
    importAls.isImportPreview = true;
    const { trx, rollback } = fakeTrx();
    await created(trx);
    rollback(new DryRunRollback());
    await flush();

    expect(calls).toEqual([]);
  });

  it('sets the flag, then schedules the job, once the save commits', async () => {
    const { trx, commit } = fakeTrx();
    await created(trx);
    expect(calls).toEqual([]);

    commit();
    await flush();
    expect(calls).toEqual(['flag:true', 'schedule']);
  });

  it('sets the flag and schedules the job once a delete commits', async () => {
    const { trx, commit } = fakeTrx();
    await deleted(trx);
    commit();
    await flush();
    expect(calls).toEqual(['flag:true', 'schedule']);
  });
});
