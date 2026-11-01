import { sumBy, omit } from 'lodash';
import * as moment from 'moment';
import * as R from 'ramda';
import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import * as composeAsync from 'async/compose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  IManualJournalEventCreatedPayload,
  IManualJournalCreatingPayload,
} from '../types/ManualJournals.types';
import { CommandManualJournalValidators } from './CommandManualJournalValidators.service';
import { AutoIncrementManualJournal } from './AutoIncrementManualJournal.service';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { events } from '@/common/events/events';
import { ManualJournal } from '../models/ManualJournal';
import { assocItemEntriesDefaultIndex } from '@/utils/associate-item-entries-index';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { ManualJournalBranchesDTOTransformer } from '@/modules/Branches/integrations/ManualJournals/ManualJournalDTOTransformer.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { CreateManualJournalDto } from '../dtos/ManualJournal.dto';

@Injectable()
export class CreateManualJournalService {
  constructor(
    private tenancyContext: TenancyContext,
    private eventPublisher: EventEmitter2,
    private uow: UnitOfWork,
    private validator: CommandManualJournalValidators,
    private autoIncrement: AutoIncrementManualJournal,
    private branchesDTOTransformer: ManualJournalBranchesDTOTransformer,

    @Inject(ManualJournal.name)
    private manualJournalModel: TenantModelProxy<typeof ManualJournal>,
  ) {}

  /**
   * Transform the new manual journal DTO to upsert graph operation.
   * @param {IManualJournalDTO} manualJournalDTO - Manual jorunal DTO.
   * @returns {Promise<ManualJournal>}
   */
  private async transformNewDTOToModel(
    manualJournalDTO: CreateManualJournalDto,
  ): Promise<ManualJournal> {
    const amount = sumBy(manualJournalDTO.entries, 'credit') || 0;
    const date = moment(manualJournalDTO.date).format('YYYY-MM-DD');

    // The manual or auto-increment journal number (the final auto number is
    // picked inside the save, see `makeJournalEntries`).
    const journalNumber =
      manualJournalDTO.journalNumber ||
      (await this.autoIncrement.getNextJournalNumber());

    const tenant = await this.tenancyContext.getTenant(true);
    const authorizedUser = await this.tenancyContext.getSystemUser();

    const entries = R.compose(
      // Associate the default index to each item entry.
      assocItemEntriesDefaultIndex,
    )(manualJournalDTO.entries);

    const initialDTO = {
      ...omit(manualJournalDTO, ['publish', 'attachments']),
      ...(manualJournalDTO.publish
        ? { publishedAt: moment().toMySqlDateTime() }
        : {}),
      amount,
      date,
      currencyCode:
        manualJournalDTO.currencyCode || tenant?.metadata?.baseCurrency,
      exchangeRate: manualJournalDTO.exchangeRate || 1,
      journalNumber,
      entries,
      userId: authorizedUser.id,
    };
    return composeAsync(
      // Omits the `branchId` from entries if multiply branches feature not active.
      this.branchesDTOTransformer.transformDTO,
    )(initialDTO) as ManualJournal;
  }

  /**
   * Authorize the manual journal creating.
   * @param {number} tenantId
   * @param {IManualJournalDTO} manualJournalDTO
   * @param {ISystemUser} authorizedUser
   */
  private authorize = async (manualJournalDTO: CreateManualJournalDto) => {
    const tenant = await this.tenancyContext.getTenant(true);

    // Validate the total credit should equals debit.
    this.validator.valdiateCreditDebitTotalEquals(manualJournalDTO);

    // Validate the contacts existance.
    await this.validator.validateContactsExistance(manualJournalDTO);

    // Validate entries accounts existance.
    await this.validator.validateAccountsExistance(manualJournalDTO);

    // Validate manual journal number require when auto-increment not enabled.
    if (!(await this.autoIncrement.autoIncrementEnabled())) {
      this.validator.validateJournalNoRequireWhenAutoNotEnabled(
        manualJournalDTO.journalNumber,
      );
    }
    // Validate accounts with contact type from the given config.
    await this.validator.dynamicValidateAccountsWithContactType(
      manualJournalDTO.entries,
    );
    // Validates the accounts currency with journal currency.
    await this.validator.validateJournalCurrencyWithAccountsCurrency(
      manualJournalDTO,
      tenant.metadata.baseCurrency,
    );
  };

  /**
   * Make journal entries.
   * @param {number} tenantId
   * @param {IManualJournalDTO} manualJournalDTO
   * @param {ISystemUser} authorizedUser
   */
  public makeJournalEntries = async (
    manualJournalDTO: CreateManualJournalDto,
    trx?: Knex.Transaction,
  ): Promise<ManualJournal> => {
    // Authorize manual journal creating.
    await this.authorize(manualJournalDTO);
    // Transformes the next DTO to model.
    const manualJournalObj =
      await this.transformNewDTOToModel(manualJournalDTO);

    // Creates a manual journal transactions with associated transactions
    // under unit-of-work envirement.
    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Picks the number inside the save, one save at a time, so two
      // journals saved at the same moment never share a number.
      manualJournalObj.journalNumber =
        (await this.autoIncrement.reserveJournalNumber(
          manualJournalDTO.journalNumber,
          trx,
        )) || manualJournalObj.journalNumber;

      // Validate manual journal uniquiness on the storage.
      if (manualJournalObj.journalNumber) {
        await this.validator.validateManualJournalNoUnique(
          manualJournalObj.journalNumber,
          undefined,
          trx,
        );
      }
      // Triggers `onManualJournalCreating` event.
      await this.eventPublisher.emitAsync(events.manualJournals.onCreating, {
        manualJournalDTO,
        trx,
      } as IManualJournalCreatingPayload);

      // Upsert the manual journal object.
      const manualJournal = await this.manualJournalModel()
        .query(trx)
        .upsertGraph({
          ...manualJournalObj,
        });
      // Triggers `onManualJournalCreated` event.
      await this.eventPublisher.emitAsync(events.manualJournals.onCreated, {
        manualJournal,
        manualJournalDTO,
        trx,
      } as IManualJournalEventCreatedPayload);

      return manualJournal;
    }, trx);
  };
}
