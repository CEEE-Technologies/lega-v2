import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { SettingsStore } from '../Settings/SettingsStore';
import { SETTINGS_PROVIDER } from '../Settings/Settings.types';
import { Features } from '@/common/types/Features';

@Injectable()
export class BranchesSettingsService {
  constructor(
    @Inject(SETTINGS_PROVIDER)
    private readonly settingsStore: () => SettingsStore,
  ) {}

  /**
   * Marks multi-branches as activated.
   * @param {Knex.Transaction} trx - Saved inside this transaction when given.
   */
  public markMultiBranchesAsActivated = async (trx?: Knex.Transaction) => {
    const settingsStore = await this.settingsStore();

    settingsStore.set({ group: 'features', key: Features.BRANCHES, value: 1 });

    await settingsStore.save(trx);
  };

  /**
   * Retrieves whether multi-branches is active.
   */
  public isMultiBranchesActive = async () => {
    const settingsStore = await this.settingsStore();

    return settingsStore.get({ group: 'features', key: Features.BRANCHES });
  };
}
