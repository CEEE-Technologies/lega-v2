import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import {
  getLandedCostSources,
  IDataHealthLandedCostFromInventory,
} from '@/modules/AccountingBasis/DataHealthCheckRound3';
import { getLockedPeriodChecker } from '@/modules/AccountingBasis/MoneyHealthCheck';
import { RevertAllocatedLandedCost } from './RevertAllocatedLandedCost.service';

/** A landed cost taken from an inventory bill line (health check H11 (c)). */
export interface ILandedCostFromInventory
  extends IDataHealthLandedCostFromInventory {
  /** The date of the bill the cost was allocated to. */
  billDate: string;
  /** In a locked period: listed, never removed. */
  locked: boolean;
}

export interface ILandedCostsFromInventoryRepairResult {
  removed: ILandedCostFromInventory[];
  skipped: ILandedCostFromInventory[];
  failed: Array<ILandedCostFromInventory & { error: string }>;
}

/**
 * Before Q9 a landed cost could be allocated from an inventory bill line.
 * That line's cost had already gone into stock with its own bill, so the
 * allocation put it into stock a second time (on the other bill's items)
 * and credited the line's cost account, which the bill never debited.
 *
 * The repair removes each such allocation with the app's own undo
 * (`RevertAllocatedLandedCost`): it deletes the allocation, its stock and
 * ledger rows, resets the source line's allocated amount and queues the
 * cost recompute. The cost then stays once, in the source item's stock.
 * Allocations on a bill in a locked period are listed and skipped.
 * Run only on request: `tenants:repair-landed-costs-from-inventory`.
 */
@Injectable()
export class LandedCostsFromInventoryRepairService {
  constructor(
    private readonly revertAllocatedLandedCost: RevertAllocatedLandedCost,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Lists the landed costs taken from an inventory bill line, the same list
   * as health check H11 (c). Changes nothing.
   */
  public async scan(): Promise<ILandedCostFromInventory[]> {
    const knex = this.tenantKnex();
    const { fromInventory } = await getLandedCostSources(knex);
    if (fromInventory.length === 0) return [];

    const isLocked = await getLockedPeriodChecker(knex);
    const bills: Array<{ id: number; billDate: any }> = await knex
      .queryBuilder()
      .from('bills')
      .whereIn('id', [...new Set(fromInventory.map((item) => item.billId))])
      .select('id', 'bill_date as billDate');
    const dates = new Map(
      bills.map((bill) => [Number(bill.id), toDateString(bill.billDate)]),
    );
    return fromInventory.map((item) => {
      const billDate = dates.get(Number(item.billId)) ?? null;
      return {
        ...item,
        billDate,
        // The undo is guarded by the date of the bill the cost was put on.
        locked: billDate ? isLocked(billDate, 'Bill') : false,
      };
    });
  }

  /**
   * Removes the listed allocations, each in its own transaction, skipping
   * the ones in a locked period.
   */
  public async repair(): Promise<ILandedCostsFromInventoryRepairResult> {
    const result: ILandedCostsFromInventoryRepairResult = {
      removed: [],
      skipped: [],
      failed: [],
    };
    for (const item of await this.scan()) {
      if (item.locked) {
        result.skipped.push(item);
        continue;
      }
      try {
        await this.revertAllocatedLandedCost.deleteAllocatedLandedCost(
          item.landedCostId,
        );
        result.removed.push(item);
      } catch (error) {
        result.failed.push({ ...item, error: error?.message ?? `${error}` });
      }
    }
    return result;
  }
}

const toDateString = (value: any): string | null => {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n: number) => `${n}`.padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return `${value}`.slice(0, 10);
};
