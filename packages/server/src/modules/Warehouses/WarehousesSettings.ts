import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { SettingsStore } from '../Settings/SettingsStore';
import { SETTINGS_PROVIDER } from '../Settings/Settings.types';
import { Features } from '@/common/types/Features';

@Injectable()
export class WarehousesSettings {
  constructor(
    @Inject(SETTINGS_PROVIDER)
    private readonly settingsStore: () => SettingsStore,
  ) {}

  /**
   * Marks multi-warehouses as activated.
   * @param {Knex.Transaction} trx - Saves the setting inside this transaction.
   */
  public markMutliwarehoussAsActivated = async (trx?: Knex.Transaction) => {
    const settings = await this.settingsStore();

    settings.set({ group: 'features', key: Features.WAREHOUSES, value: 1 });

    await settings.save(trx);
  };

  /**
   * Determines multi-warehouses is active.
   * @param {number} tenantId
   * @returns {boolean}
   */
  public isMultiWarehousesActive = async () => {
    const settings = await this.settingsStore();

    return settings.get({ group: 'features', key: Features.WAREHOUSES });
  };
}
