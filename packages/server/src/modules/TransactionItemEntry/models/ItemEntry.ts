import { DiscountType } from '@/common/types/Discount';
import { BaseModel } from '@/models/Model';
import { Item } from '@/modules/Items/models/Item';
import { calcLineMoney, ILineMoney, subtractMoney } from '@bigcapital/utils';
import { Model } from 'objection';

export class ItemEntry extends BaseModel {
  public referenceType: string;
  public referenceId: string;

  public index: number;
  public itemId: number;
  public description: string;

  public sellAccountId: number;
  public costAccountId: number;

  public quantity: number;
  public rate: number;

  public taxRate: number;
  public isInclusiveTax: number;

  public landedCost: boolean;
  public allocatedCostAmount: number;

  public discountType: DiscountType;
  public discount: number;

  public adjustment: number;

  public taxRateId: number;

  public warehouseId: number;

  item: Item;

  /**
   * Table name.
   * @returns {string}
   */
  static get tableName() {
    return 'items_entries';
  }

  /**
   * Timestamps columns.
   * @returns {string[]}
   */
  get timestamps() {
    return ['createdAt', 'updatedAt'];
  }

  /**
   * Virtual attributes.
   * @returns {string[]}
   */
  static get virtualAttributes() {
    return [
      // Amount (qty * rate)
      'amount',

      'taxAmount',

      // Subtotal (qty * rate) + (tax inclusive)
      'subtotalInclusingTax',

      // Subtotal Tax Exclusive (Subtotal - Tax Amount)
      'subtotalExcludingTax',

      // Subtotal (qty * rate) + (tax inclusive)
      'subtotal',

      // Discount (Is percentage ? amount * discount : discount)
      'discountAmount',

      // Total (Subtotal - Discount)
      'total',
    ];
  }

  /**
   * Item entry total.
   * Amount of item entry includes tax and subtracted discount amount.
   * @returns {number}
   */
  /**
   * The money amounts of the line, each rounded to cents, with the tax on
   * the amount after the line discount (same calculator as the webapp).
   * @returns {ILineMoney}
   */
  get lineMoney(): ILineMoney {
    return calcLineMoney({
      quantity: this.quantity,
      rate: this.rate,
      discount: this.discount,
      discountType: this.discountType || DiscountType.Percentage,
      taxRate: this.taxRate,
      isInclusiveTax: this.isInclusiveTax,
    });
  }

  /**
   * Line total after the discount, tax included.
   * @returns {number}
   */
  get total() {
    return this.lineMoney.total;
  }

  /**
   * Total (excluding tax).
   * @returns {number}
   */
  get totalExcludingTax() {
    return this.lineMoney.totalExcludingTax;
  }

  /**
   * Item entry amount.
   * Amount of item entry that may include or exclude tax.
   * @returns {number}
   */
  get amount() {
    return this.lineMoney.amount;
  }

  /**
   * Subtotal amount (tax inclusive).
   * @returns {number}
   */
  get subtotal() {
    return this.subtotalInclusingTax;
  }

  /**
   * Item entry amount including tax.
   * @returns {number}
   */
  get subtotalInclusingTax() {
    return this.isInclusiveTax ? this.amount : this.amount + this.taxAmount;
  }

  /**
   * Subtotal amount (tax exclusive).
   * @returns {number}
   */
  get subtotalExcludingTax() {
    return this.isInclusiveTax ? this.amount - this.taxAmount : this.amount;
  }

  /**
   * Discount amount.
   * @returns {number}
   */
  get discountAmount() {
    return this.lineMoney.discountAmount;
  }

  /**
   * Tag rate fraction.
   * @returns {number}
   */
  get tagRateFraction() {
    return this.taxRate / 100;
  }

  /**
   * Tax amount withheld.
   * @returns {number}
   */
  get taxAmount() {
    return this.lineMoney.taxAmount;
  }

  /**
   * Remain unallocated landed cost.
   * @return {number}
   */
  get unallocatedCostAmount() {
    return Math.max(subtractMoney(this.amount, this.allocatedCostAmount), 0);
  }

  static calcAmount(itemEntry) {
    const { discount, discountType, quantity, rate } = itemEntry;

    // The line amount after the discount, rounded to cents (tax inclusive
    // lines keep their tax inside it).
    return calcLineMoney({
      quantity,
      rate,
      discount,
      discountType: discountType || DiscountType.Percentage,
    }).taxableAmount;
  }

  /**
   * Item entry relations.
   */
  static get relationMappings() {
    const { Item } = require('../../Items/models/Item');
    const { SaleInvoice } = require('../../SaleInvoices/models/SaleInvoice');
    const { Bill } = require('../../Bills/models/Bill');
    const { SaleReceipt } = require('../../SaleReceipts/models/SaleReceipt');
    const { SaleEstimate } = require('../../SaleEstimates/models/SaleEstimate');
    const { TaxRateModel } = require('../../TaxRates/models/TaxRate.model');
    // const { Expense } = require('../../Expenses/models/Expense.model');
    // const ProjectTask = require('models/Task');

    return {
      item: {
        relation: Model.BelongsToOneRelation,
        modelClass: Item,
        join: {
          from: 'items_entries.itemId',
          to: 'items.id',
        },
      },

      invoice: {
        relation: Model.BelongsToOneRelation,
        modelClass: SaleInvoice,
        join: {
          from: 'items_entries.referenceId',
          to: 'sales_invoices.id',
        },
      },

      bill: {
        relation: Model.BelongsToOneRelation,
        modelClass: Bill,
        join: {
          from: 'items_entries.referenceId',
          to: 'bills.id',
        },
      },

      estimate: {
        relation: Model.BelongsToOneRelation,
        modelClass: SaleEstimate,
        join: {
          from: 'items_entries.referenceId',
          to: 'sales_estimates.id',
        },
      },

      /**
       * Sale receipt reference.
       */
      receipt: {
        relation: Model.BelongsToOneRelation,
        modelClass: SaleReceipt,
        join: {
          from: 'items_entries.referenceId',
          to: 'sales_receipts.id',
        },
      },

      /**
       * Project task reference.
       */
      // projectTaskRef: {
      //   relation: Model.HasManyRelation,
      //   modelClass: ProjectTask.default,
      //   join: {
      //     from: 'items_entries.projectRefId',
      //     to: 'tasks.id',
      //   },
      // },

      /**
       * Project expense reference.
       */
      // projectExpenseRef: {
      //   relation: Model.HasManyRelation,
      //   modelClass: Expense.default,
      //   join: {
      //     from: 'items_entries.projectRefId',
      //     to: 'expenses_transactions.id',
      //   },
      // },

      /**
       * Project bill reference.
       */
      // projectBillRef: {
      //   relation: Model.HasManyRelation,
      //   modelClass: Bill,
      //   join: {
      //     from: 'items_entries.projectRefId',
      //     to: 'bills.id',
      //   },
      // },

      /**
       * Tax rate reference.
       */
      tax: {
        relation: Model.HasOneRelation,
        modelClass: TaxRateModel,
        join: {
          from: 'items_entries.taxRateId',
          to: 'tax_rates.id',
        },
      },
    };
  }
}
