import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { uniq } from 'lodash';
import {
  BillLandedCostsBridge,
  IBillLandedCostEntryDTO,
  IBillLandedCostEntryLike,
  IBillLandedCostsProvider,
} from '@/modules/Bills/integrations/BillLandedCostsBridge';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Item } from '@/modules/Items/models/Item';
import { ServiceError } from '@/modules/Items/ServiceError';
import { transformToMap } from '@/utils/transform-to-key';
import { BillLandedCost } from './models/BillLandedCost';
import { TransactionLandedCostEntriesService } from './TransactionLandedCostEntries.service';
import { ERRORS } from './utils';

@Injectable()
export class LandedCostsBridgeProvider
  implements IBillLandedCostsProvider, OnModuleInit
{
  constructor(
    private readonly bridge: BillLandedCostsBridge,
    private readonly transactionLandedCostEntries: TransactionLandedCostEntriesService,

    @Inject(BillLandedCost.name)
    private readonly billLandedCostModel: TenantModelProxy<
      typeof BillLandedCost
    >,

    @Inject(Item.name)
    private readonly itemModel: TenantModelProxy<typeof Item>,
  ) {}

  /**
   * Registers the landed cost provider on the bills bridge.
   */
  onModuleInit() {
    this.bridge.register(this);
  }

  /**
   * Validates the given bill has no associated allocated landed costs.
   * @param {number} billId - Bill id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public async validateBillHasNoLandedCosts(
    billId: number,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const billLandedCosts = await this.billLandedCostModel()
      .query(trx)
      .where('billId', billId);

    if (billLandedCosts.length > 0) {
      throw new ServiceError(ERRORS.BILL_HAS_ASSOCIATED_LANDED_COSTS);
    }
  }

  /**
   * Validates no landed cost was allocated from the given bill. Deleting it
   * would leave the cost in the target bill's stock with nothing paying it.
   * @param {number} billId - Bill id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public async validateBillNotLandedCostSource(
    billId: number,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const landedCosts = await this.billLandedCostModel()
      .query(trx)
      .where('fromTransactionType', 'Bill')
      .where('fromTransactionId', billId)
      .withGraphFetched('bill');

    if (landedCosts.length > 0) {
      const bills = uniq(
        landedCosts.map((cost) => cost.bill?.billNumber || `#${cost.billId}`),
      );
      throw new ServiceError(
        ERRORS.BILL_USED_AS_LANDED_COST,
        `Used as landed cost on ${bills.length > 1 ? 'bills' : 'bill'} ${bills.join(', ')}; remove it there first.`,
        { billIds: uniq(landedCosts.map((cost) => cost.billId)) },
      );
    }
  }

  /**
   * Validates that the bill lines flagged as landed cost are service or
   * non-inventory lines (decision D7, the rule the screens use).
   *
   * The landed cost line is posted to its cost account (freight, customs)
   * by the bill; allocating it then moves it from that account into the
   * stock of the target items, so it is counted in stock once. An
   * inventory line would already be stock of its own item, so allocating
   * it too would count the freight in stock twice.
   * @param {IBillLandedCostEntryDTO[]} entries - Bill entries.
   */
  public async validateBillEntries(
    entries: IBillLandedCostEntryDTO[],
  ): Promise<void> {
    const entriesItemsIds = entries.map((e) => e.itemId);
    const entriesItems = await this.itemModel()
      .query()
      .whereIn('id', entriesItemsIds);

    const entriesItemsById = transformToMap(entriesItems, 'id');

    const inventoryHasCost = entries.filter((entry) => {
      const item = entriesItemsById.get(entry.itemId);

      return entry.landedCost && item?.type === 'inventory';
    });
    if (inventoryHasCost.length > 0) {
      throw new ServiceError(
        ERRORS.LANDED_COST_ENTRIES_SHOULD_NOT_BE_INVENTORY_ITEMS,
        'Landed cost can only be on service or non-inventory lines. An inventory line already adds its cost to stock.',
      );
    }
  }

  /**
   * Validates the bill edit operation against associated landed costs.
   * @param {IBillLandedCostEntryLike[]} oldEntries - Old bill entries.
   * @param {IBillLandedCostEntryLike[]} newEntries - New bill entries.
   */
  public validateBillEditEntries(
    oldEntries: IBillLandedCostEntryLike[],
    newEntries: IBillLandedCostEntryLike[],
  ): void {
    this.transactionLandedCostEntries.validateLandedCostEntriesNotDeleted(
      oldEntries,
      newEntries,
    );
    this.transactionLandedCostEntries.validateLocatedCostEntriesSmallerThanNewEntries(
      oldEntries,
      newEntries,
    );
  }
}
