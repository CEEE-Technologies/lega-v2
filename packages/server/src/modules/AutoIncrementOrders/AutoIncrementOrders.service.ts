import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { SettingsStore } from '../Settings/SettingsStore';
import { SETTINGS_PROVIDER } from '../Settings/Settings.types';
import { transactionIncrement } from '@/utils/transaction-increment';

/**
 * Auto increment orders service.
 */
@Injectable()
export class AutoIncrementOrdersService {
  constructor(
    @Inject(SETTINGS_PROVIDER)
    private readonly settingsStore: () => SettingsStore,
  ) {}

  /**
   * Check if the auto increment is enabled for the given settings group.
   * @param {string} settingsGroup - Settings group.
   * @returns {Promise<boolean>}
   */
  public autoIncrementEnabled = async (
    settingsGroup: string,
  ): Promise<boolean> => {
    const settingsStore = await this.settingsStore();
    const group = settingsGroup;

    // Settings service transaction number and prefix.
    return settingsStore.get({ group, key: 'auto_increment' }, false);
  };

  /**
   * Retrieve the next service transaction number.
   * @param {string} settingsGroup
   * @param {Function} getMaxTransactionNo
   * @return {Promise<string>}
   */
  async getNextTransactionNumber(group: string): Promise<string> {
    const settingsStore = await this.settingsStore();

    // Settings service transaction number and prefix.
    const autoIncrement = await this.autoIncrementEnabled(group);

    const settingNo = settingsStore.get({ group, key: 'next_number' }, '');
    const settingPrefix = settingsStore.get(
      { group, key: 'number_prefix' },
      '',
    );
    return autoIncrement ? `${settingPrefix}${settingNo}` : '';
  }

  /**
   * Picks the number of a new document inside its save.
   *
   * Locks the group's `next_number` setting row (FOR UPDATE) for the rest of
   * the save, so two saves of the same document type run their numbering one
   * after the other: the second waits, then reads the counter the first one
   * bumped. Call it before the "number already used" check, so that check
   * also runs one save at a time.
   *
   * When auto-increment is on the counter is bumped inside the same save
   * (a rolled-back save leaves it unchanged). The typed number is kept when
   * one was given, otherwise the reserved number is returned.
   * @param {string} group - Settings group, e.g. `sales_invoices`.
   * @param {string} givenNumber - The number the user typed, if any.
   * @param {Knex.Transaction} trx - The document save transaction.
   * @returns {Promise<string>} The number to save ('' when none).
   */
  async reserveNextNumber(
    group: string,
    givenNumber: string | null | undefined,
    trx: Knex.Transaction,
  ): Promise<string> {
    const settingsStore = await this.settingsStore();
    const autoIncrement = settingsStore.get(
      { group, key: 'auto_increment' },
      false,
    );
    const prefix = settingsStore.get({ group, key: 'number_prefix' }, '');

    // Read the counter from the database, not the request cache, under a lock.
    const row = await trx('settings')
      .where({ group, key: 'next_number' })
      .orderBy('id')
      .forUpdate()
      .first();

    if (!autoIncrement) {
      return givenNumber || '';
    }
    const nextNumber =
      row?.value ?? settingsStore.get({ group, key: 'next_number' }, '');

    if (row) {
      await trx('settings')
        .where({ id: row.id })
        .update({ value: transactionIncrement(`${nextNumber}`) });
    } else {
      await trx('settings').insert({
        group,
        key: 'next_number',
        value: transactionIncrement(`${nextNumber}`),
      });
    }
    return givenNumber || `${prefix}${nextNumber}`;
  }
}
