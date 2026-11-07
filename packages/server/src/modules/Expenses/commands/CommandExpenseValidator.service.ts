import { moneyGt, sumMoneyBy } from '@bigcapital/utils';
import { difference, uniq } from 'lodash';
import { Knex } from 'knex';
import { ERRORS, SUPPORTED_EXPENSE_PAYMENT_ACCOUNT_TYPES } from '../constants';
import { ACCOUNT_ROOT_TYPE } from '@/constants/accounts';
import { Account } from '@/modules/Accounts/models/Account.model';
import { Inject, Injectable } from '@nestjs/common';
import { Expense } from '../models/Expense.model';
import { ServiceError } from '@/modules/Items/ServiceError';
import { CreateExpenseDto, EditExpenseDto } from '../dtos/Expense.dto';
import { ExpenseCategory } from '../models/ExpenseCategory.model';
import { BillLandedCost } from '@/modules/EE/BillLandedCosts/models/BillLandedCost';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class CommandExpenseValidator {
  constructor(
    @Inject(BillLandedCost.name)
    private readonly billLandedCostModel: TenantModelProxy<
      typeof BillLandedCost
    >,
  ) {}

  /**
   * Validates expense categories not equals zero.
   * @param  {IExpenseCreateDTO | IExpenseEditDTO} expenseDTO
   * @throws {ServiceError}
   */
  public validateCategoriesNotEqualZero = (
    expenseDTO: CreateExpenseDto | EditExpenseDto,
  ) => {
    const totalAmount = sumMoneyBy(expenseDTO.categories, 'amount');

    if (!moneyGt(totalAmount, 0)) {
      throw new ServiceError(ERRORS.TOTAL_AMOUNT_EQUALS_ZERO);
    }
  };

  /**
   * Retrieve expense accounts or throw error in case one of the given accounts
   * not found not the storage.
   * @param {number} expenseAccountsIds
   * @throws {ServiceError}
   * @returns {Promise<IAccount[]>}
   */
  public validateExpensesAccountsExistance(
    expenseAccounts: Account[],
    DTOAccountsIds: number[],
  ) {
    const storedExpenseAccountsIds = expenseAccounts.map((a: Account) => a.id);
    const notStoredAccountsIds = difference(
      DTOAccountsIds,
      storedExpenseAccountsIds,
    );
    if (notStoredAccountsIds.length > 0) {
      throw new ServiceError(ERRORS.SOME_ACCOUNTS_NOT_FOUND);
    }
  }

  /**
   * Validate expenses accounts type.
   * @param {Account[]} expensesAccounts
   * @throws {ServiceError}
   */
  public validateExpensesAccountsType = (expensesAccounts: Account[]) => {
    const invalidExpenseAccounts: number[] = [];

    expensesAccounts.forEach((expenseAccount) => {
      if (!expenseAccount.isRootType(ACCOUNT_ROOT_TYPE.EXPENSE)) {
        invalidExpenseAccounts.push(expenseAccount.id);
      }
    });
    if (invalidExpenseAccounts.length > 0) {
      throw new ServiceError(ERRORS.EXPENSES_ACCOUNT_HAS_INVALID_TYPE);
    }
  };

  /**
   * Validates payment account type in case has invalid type throws errors.
   * @param {Account} paymentAccount
   * @throws {ServiceError}
   */
  public validatePaymentAccountType = (paymentAccount: Account) => {
    if (
      !paymentAccount.isAccountType(SUPPORTED_EXPENSE_PAYMENT_ACCOUNT_TYPES)
    ) {
      throw new ServiceError(ERRORS.PAYMENT_ACCOUNT_HAS_INVALID_TYPE);
    }
  };

  /**
   * Retrieves the landed costs allocated from the given expense, with the
   * bills they were allocated to.
   * @param {number} expenseId - Expense id.
   * @param {number[]} entriesIds - Only the costs from these lines, if given.
   * @param {Knex.Transaction} trx
   */
  private getAssociatedLandedCosts(
    expenseId: number,
    entriesIds?: number[],
    trx?: Knex.Transaction,
  ) {
    return this.billLandedCostModel()
      .query(trx)
      .where('fromTransactionType', 'Expense')
      .where('fromTransactionId', expenseId)
      .modify((q) => {
        if (entriesIds) q.whereIn('fromTransactionEntryId', entriesIds);
      })
      .withGraphFetched('bill');
  }

  /**
   * "Used as landed cost on bill B-00012; remove it there first."
   * @param {BillLandedCost[]} landedCosts
   */
  private landedCostMessage(landedCosts: BillLandedCost[]) {
    const bills = uniq(
      landedCosts.map((cost) => cost.bill?.billNumber || `#${cost.billId}`),
    );
    const label = bills.length > 1 ? 'bills' : 'bill';
    return `Used as landed cost on ${label} ${bills.join(', ')}; remove it there first.`;
  }

  /**
   * Validates the expense has no landed cost allocated from it. Deleting it
   * would leave the cost in the target bill's stock with nothing paying it.
   * @param {number} expenseId
   * @param {Knex.Transaction} trx
   */
  public async validateNoAssociatedLandedCost(
    expenseId: number,
    trx?: Knex.Transaction,
  ) {
    const associatedLandedCosts = await this.getAssociatedLandedCosts(
      expenseId,
      undefined,
      trx,
    );
    if (associatedLandedCosts.length > 0) {
      throw new ServiceError(
        ERRORS.EXPENSE_HAS_ASSOCIATED_LANDED_COST,
        this.landedCostMessage(associatedLandedCosts),
        { billIds: uniq(associatedLandedCosts.map((cost) => cost.billId)) },
      );
    }
  }

  /**
   * Validates an edit keeps every line a landed cost was allocated from, and
   * keeps each such line at least as large as what was allocated from it.
   * Lines are matched by id; a line sent without its id is a new line.
   * @param {number} expenseId
   * @param {ExpenseCategory[]} oldCategories - Stored lines (locked).
   * @param {EditExpenseDto['categories']} newCategories - Lines of the edit.
   * @param {Knex.Transaction} trx
   */
  public async validateLandedCostCategoriesOnEdit(
    expenseId: number,
    oldCategories: ExpenseCategory[],
    newCategories: EditExpenseDto['categories'],
    trx?: Knex.Transaction,
  ) {
    const allocated = oldCategories.filter((category) =>
      moneyGt(category.allocatedCostAmount || 0, 0),
    );
    if (allocated.length === 0) return;

    const newById = new Map(
      newCategories.filter((c) => c.id).map((c) => [c.id, c]),
    );
    const removed = allocated.filter((category) => !newById.has(category.id));
    const reduced = allocated.filter((category) => {
      const newCategory = newById.get(category.id);
      return (
        newCategory &&
        moneyGt(category.allocatedCostAmount, newCategory.amount || 0)
      );
    });
    if (removed.length > 0) {
      const costs = await this.getAssociatedLandedCosts(
        expenseId,
        removed.map((c) => c.id),
        trx,
      );
      throw new ServiceError(
        ERRORS.ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED,
        this.landedCostMessage(costs),
        { categoriesIds: removed.map((c) => c.id) },
      );
    }
    if (reduced.length > 0) {
      const costs = await this.getAssociatedLandedCosts(
        expenseId,
        reduced.map((c) => c.id),
        trx,
      );
      throw new ServiceError(
        ERRORS.LOCATED_COST_ENTRIES_SHOULD_BIGGE_THAN_NEW_ENTRIES,
        `A line can't be less than the landed cost allocated from it (${reduced
          .map((c) => c.allocatedCostAmount)
          .join(', ')}). ${this.landedCostMessage(costs)}`,
        { categoriesIds: reduced.map((c) => c.id) },
      );
    }
  }

  /**
   * Validates the edit's line ids belong to the expense.
   * @param {ExpenseCategory[]} oldCategories
   * @param {EditExpenseDto['categories']} newCategories
   */
  public validateCategoriesIdsExist(
    oldCategories: ExpenseCategory[],
    newCategories: EditExpenseDto['categories'],
  ) {
    const oldIds = oldCategories.map((c) => c.id);
    const unknown = newCategories.filter((c) => c.id && !oldIds.includes(c.id));
    if (unknown.length > 0) {
      throw new ServiceError(ERRORS.EXPENSE_CATEGORIES_IDS_NOT_FOUND, '', {
        ids: unknown.map((c) => c.id),
      });
    }
  }

  /**
   * Validates expenses is not already published before.
   * @param {IExpense} expense
   */
  public validateExpenseIsNotPublished(expense: Expense) {
    if (expense.publishedAt) {
      throw new ServiceError(ERRORS.EXPENSE_ALREADY_PUBLISHED);
    }
  }
}
