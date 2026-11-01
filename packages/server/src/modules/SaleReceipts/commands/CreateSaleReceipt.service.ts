import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import {
  ISaleReceiptCreatedPayload,
  ISaleReceiptCreatingPayload,
} from '../types/SaleReceipts.types';
import { SaleReceiptDTOTransformer } from './SaleReceiptDTOTransformer.service';
import { SaleReceiptValidators } from './SaleReceiptValidators.service';
import { ItemsEntriesService } from '@/modules/Items/ItemsEntries.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { SaleReceipt } from '../models/SaleReceipt';
import { Customer } from '@/modules/Customers/models/Customer';
import { events } from '@/common/events/events';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CreateSaleReceiptDto } from '../dtos/SaleReceipt.dto';
import { SaleReceiptIncrement } from './SaleReceiptIncrement.service';

@Injectable()
export class CreateSaleReceipt {
  /**
   * @param {ItemsEntriesService} itemsEntriesService - Items entries service.
   * @param {EventEmitter2} eventPublisher - Event emitter.
   * @param {UnitOfWork} uow - Unit of work.
   * @param {SaleReceiptDTOTransformer} transformer - Sale receipt DTO transformer.
   * @param {SaleReceiptValidators} validators - Sale receipt validators.
   * @param {typeof SaleReceipt} saleReceiptModel - Sale receipt model.
   * @param {typeof Customer} customerModel - Customer model.
   */
  constructor(
    private readonly itemsEntriesService: ItemsEntriesService,
    private readonly eventEmitter: EventEmitter2,
    private readonly uow: UnitOfWork,
    private readonly transformer: SaleReceiptDTOTransformer,
    private readonly validators: SaleReceiptValidators,
    private readonly receiptIncrement: SaleReceiptIncrement,

    @Inject(SaleReceipt.name)
    private readonly saleReceiptModel: TenantModelProxy<typeof SaleReceipt>,

    @Inject(Customer.name)
    private readonly customerModel: TenantModelProxy<typeof Customer>,
  ) {}

  /**
   * Creates a new sale receipt with associated entries.
   * @async
   * @param {ISaleReceiptDTO} saleReceiptDTO
   * @return {Promise<ISaleReceipt>}
   */
  public async createSaleReceipt(
    saleReceiptDTO: CreateSaleReceiptDto,
    trx?: Knex.Transaction,
  ): Promise<SaleReceipt> {
    // Retrieves the payment customer model.
    const paymentCustomer = await this.customerModel()
      .query()
      .findById(saleReceiptDTO.customerId)
      .throwIfNotFound();

    // Transform sale receipt DTO to model.
    const saleReceiptObj = await this.transformer.transformDTOToModel(
      saleReceiptDTO,
      paymentCustomer,
    );
    // Validate receipt deposit account existence and type.
    await this.validators.validateReceiptDepositAccountExistence(
      saleReceiptDTO.depositAccountId,
    );
    // Validate items IDs existence on the storage.
    await this.itemsEntriesService.validateItemsIdsExistance(
      saleReceiptDTO.entries,
    );
    // Validate the sellable items.
    await this.itemsEntriesService.validateNonSellableEntriesItems(
      saleReceiptDTO.entries,
    );
    // Creates a sale receipt transaction and associated transactions under UOW env.
    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Picks the number inside the save, one save at a time, so two
      // receipts saved at the same moment never share a number.
      saleReceiptObj.receiptNumber =
        (await this.receiptIncrement.reserveReceiptNumber(
          saleReceiptDTO.receiptNumber,
          trx,
        )) || saleReceiptObj.receiptNumber;

      // Validate sale receipt number uniqueness.
      if (saleReceiptObj.receiptNumber) {
        await this.validators.validateReceiptNumberUnique(
          saleReceiptObj.receiptNumber,
          undefined,
          trx,
        );
      }
      // Triggers `onSaleReceiptCreating` event.
      await this.eventEmitter.emitAsync(events.saleReceipt.onCreating, {
        saleReceiptDTO,
        trx,
      } as ISaleReceiptCreatingPayload);

      // Inserts the sale receipt graph to the storage.
      const saleReceipt = await this.saleReceiptModel()
        .query(trx)
        .upsertGraph({
          ...saleReceiptObj,
        });

      // Triggers `onSaleReceiptCreated` event.
      await this.eventEmitter.emitAsync(events.saleReceipt.onCreated, {
        saleReceipt,
        saleReceiptId: saleReceipt.id,
        saleReceiptDTO,
        trx,
      } as ISaleReceiptCreatedPayload);

      return saleReceipt;
    }, trx);
  }
}
