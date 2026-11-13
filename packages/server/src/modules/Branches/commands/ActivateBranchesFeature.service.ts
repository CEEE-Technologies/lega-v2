import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ERRORS } from '../constants';
import {
  IBranchesActivatedPayload,
  IBranchesActivatePayload,
} from '../Branches.types';
import { CreateBranchService } from './CreateBranch.service';
import { BranchesSettingsService } from '../BranchesSettings';
import { ServiceError } from '@/modules/Items/ServiceError';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { events } from '@/common/events/events';

@Injectable()
export class ActivateBranches {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly eventPublisher: EventEmitter2,
    private readonly createBranch: CreateBranchService,
    private readonly branchesSettings: BranchesSettingsService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Throws service error if multi-branches feature is already activated.
   */
  private throwIfMultiBranchesActivated = (isActivated: boolean) => {
    if (isActivated) {
      throw new ServiceError(ERRORS.MUTLI_BRANCHES_ALREADY_ACTIVATED);
    }
  };

  /**
   * Creates a new initial branch.
   */
  private createInitialBranch = (trx: Knex.Transaction) => {
    return this.createBranch.createBranch(
      {
        name: this.i18n.t('branches.head_branch'),
        code: '10001',
        primary: true,
      },
      trx,
    );
  };

  /**
   * Activate multi-branches feature.
   * @returns {Promise<void>}
   */
  public activateBranches = async (): Promise<void> => {
    const isActivated = await this.branchesSettings.isMultiBranchesActive();

    // Throw error if mutli-branches is already activated.
    this.throwIfMultiBranchesActivated(isActivated);

    // Activate multi-branches under unit-of-work environment.
    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Triggers `onBranchActivate` branch.
      await this.eventPublisher.emitAsync(events.branch.onActivate, {
        trx,
      } as IBranchesActivatePayload);

      // Create a new branch as primary branch, and mark the feature as on,
      // inside the transaction: if a later step fails, both are undone
      // (they were kept, so a retry said "already on" while the existing
      // transactions never got their branch).
      const primaryBranch = await this.createInitialBranch(trx);
      await this.branchesSettings.markMultiBranchesAsActivated(trx);

      // Triggers `onBranchActivated` branch.
      await this.eventPublisher.emitAsync(events.branch.onActivated, {
        primaryBranch,
        trx,
      } as IBranchesActivatedPayload);
    });
  };
}
