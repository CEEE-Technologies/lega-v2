import { Knex } from 'knex';
import { PromisePool } from '@supercharge/promise-pool';
import { castArray, uniq } from 'lodash';
import { DeleteBankRuleService } from './DeleteBankRule.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class DeleteBankRulesService {
  constructor(private readonly deleteBankRuleService: DeleteBankRuleService) {}

  /**
   * Delete bank rules.
   * @param {number | Array<number>} bankRuleId - The bank rule id or ids.
   * @param {Knex.Transaction} trx - The transaction.
   */
  async deleteBankRules(
    bankRuleId: number | Array<number>,
    trx?: Knex.Transaction,
  ) {
    const bankRulesIds = uniq(castArray(bankRuleId));

    const results = await PromisePool.withConcurrency(1)
      .for(bankRulesIds)
      .process(async (bankRuleId: number) => {
        await this.deleteBankRuleService.deleteBankRule(bankRuleId, trx);
      });
    // The pool collects errors instead of throwing them. A rule that failed
    // to delete must stop the save (such as the account delete it is part
    // of), so nothing is removed.
    if (results.errors?.length > 0) {
      throw results.errors[0].raw;
    }
  }
}
