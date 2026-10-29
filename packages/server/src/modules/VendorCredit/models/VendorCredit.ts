import {
  calcDiscountMoney,
  calcDocumentMoney,
  moneyGt,
  moneyIsZero,
  multiplyMoney,
  subtractMoney,
  sumMoney,
} from '@bigcapital/utils';
import { Model, raw } from 'objection';
import { Vendor } from '@/modules/Vendors/models/Vendor';
import { Warehouse } from '@/modules/Warehouses/models/Warehouse.model';
import { Branch } from '@/modules/Branches/models/Branch.model';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { DiscountType } from '@/common/types/Discount';
import { TenantBaseModel } from '@/modules/System/models/TenantBaseModel';
import { ExportableModel } from '@/modules/Export/decorators/ExportableModel.decorator';
import { ImportableModel } from '@/modules/Import/decorators/Import.decorator';
import { InjectModelMeta } from '@/modules/Tenancy/TenancyModels/decorators/InjectModelMeta.decorator';
import { VendorCreditMeta } from './VendorCredit.meta';
import { sanitizeSortDirection } from '@/modules/DynamicListing/DynamicFilter/sanitizeSortDirection';
import { InjectModelDefaultViews } from '@/modules/Views/decorators/InjectModelDefaultViews.decorator';
import { VendorCreditDefaultViews } from '../constants';
import { InjectAttachable } from '@/modules/Attachments/decorators/InjectAttachable.decorator';
import { sqlDocumentTotal, sqlMoneyLeft } from '@/utils/document-money-sql';

/**
 * SQL of the vendor credit total and the credit still left to use, in cents: the
 * same formulas as the `total` and `creditsRemaining` getters (both sides
 * come from calcDocumentMoney / document-money-sql.ts).
 */
const VENDOR_CREDIT_TOTAL_SQL = sqlDocumentTotal('AMOUNT', false);
const VENDOR_CREDIT_REMAINING_SQL = sqlMoneyLeft(
  VENDOR_CREDIT_TOTAL_SQL,
  'REFUNDED_AMOUNT',
  'INVOICED_AMOUNT',
);

/** The vendor credit money SQL, for the money parity test and reports. */
export const VENDOR_CREDIT_MONEY_SQL = {
  total: VENDOR_CREDIT_TOTAL_SQL,
  remaining: VENDOR_CREDIT_REMAINING_SQL,
};

@InjectAttachable()
@ExportableModel()
@ImportableModel()
@InjectModelMeta(VendorCreditMeta)
@InjectModelDefaultViews(VendorCreditDefaultViews)
export class VendorCredit extends TenantBaseModel {
  vendorId: number;
  amount: number;
  currencyCode: string;

  vendorCreditDate: Date;
  vendorCreditNumber: string;

  referenceNo: string;
  refundedAmount: number;
  invoicedAmount: number;
  adjustment: number;
  exchangeRate: number;
  note: string;
  openedAt: Date;
  userId: number;

  discount: number;
  discountType: DiscountType;

  branchId: number;
  warehouseId: number;

  vendor?: Vendor;
  warehouse?: Warehouse;
  branch?: Branch;
  entries?: ItemEntry[];
  attachments?: Document[];

  createdAt: Date;
  updatedAt: Date;

  /**
   * Table name
   */
  static get tableName() {
    return 'vendor_credits';
  }
  /**
   * Vendor credit amount in local currency.
   * @returns {number}
   */
  get localAmount() {
    return multiplyMoney(this.amount, this.exchangeRate);
  }

  /**
   * Vendor credit subtotal.
   * @returns {number}
   */
  get subtotal() {
    return this.amount;
  }

  /**
   * Vendor credit subtotal in local currency.
   * @returns {number}
   */
  get subtotalLocal() {
    return multiplyMoney(this.subtotal, this.exchangeRate);
  }

  /**
   * Discount amount.
   * @returns {number}
   */
  get discountAmount() {
    // Rounded to cents; a missing discount counts as 0 (never NaN).
    return calcDiscountMoney(this.subtotal, this.discount, this.discountType);
  }

  /**
   * Discount amount in local currency.
   * @returns {number | null}
   */
  get discountAmountLocal() {
    return this.discountAmount
      ? multiplyMoney(this.discountAmount, this.exchangeRate)
      : null;
  }

  /**
   * Discount percentage.
   * @returns {number | null}
   */
  get discountPercentage(): number | null {
    return this.discountType === DiscountType.Percentage ? this.discount : null;
  }

  /**
   * Adjustment amount in local currency.
   * @returns {number | null}
   */
  get adjustmentLocal() {
    return this.adjustment
      ? multiplyMoney(this.adjustment, this.exchangeRate)
      : null;
  }

  /**
   * Vendor credit total.
   * @returns {number}
   */
  get total() {
    // In whole cents; VENDOR_CREDIT_TOTAL_SQL is the SQL copy.
    return calcDocumentMoney({
      subtotal: this.subtotal,
      discount: this.discount,
      discountType: this.discountType,
      adjustment: this.adjustment,
    }).total;
  }

  /**
   * Vendor credit total in local currency.
   * @returns {number}
   */
  get totalLocal() {
    return multiplyMoney(this.total, this.exchangeRate);
  }

  /**
   * Model modifiers.
   */
  static get modifiers() {
    return {
      /**
       * Filters the credit notes in draft status.
       */
      draft(query) {
        query.where('opened_at', null);
      },

      /**
       * Filters the published vendor credits.
       */
      published(query) {
        query.whereNot('opened_at', null);
      },

      /**
       * Filters the open vendor credits.
       */
      open(query) {
        query
          .where(raw(`${VENDOR_CREDIT_REMAINING_SQL} > 0`))
          .modify('published');
      },

      /**
       * Filters the closed vendor credits.
       */
      closed(query) {
        query
          .where(raw(`${VENDOR_CREDIT_REMAINING_SQL} <= 0`))
          .modify('published');
      },

      /**
       * Status filter.
       */
      filterByStatus(query, filterType) {
        switch (filterType) {
          case 'draft':
            query.modify('draft');
            break;
          case 'published':
            query.modify('published');
            break;
          case 'open':
          default:
            query.modify('open');
            break;
          case 'closed':
            query.modify('closed');
            break;
        }
      },

      /**
       *
       */
      sortByStatus(query, order) {
        const dir = sanitizeSortDirection(order);
        query.orderByRaw(`${VENDOR_CREDIT_REMAINING_SQL} <= 0 ${dir}`);
      },
    };
  }

  /**
   * Timestamps columns.
   */
  get timestamps() {
    return ['createdAt', 'updatedAt'];
  }

  /**
   * Virtual attributes.
   */
  static get virtualAttributes() {
    return [
      'isDraft',
      'isPublished',
      'isOpen',
      'isClosed',

      'creditsRemaining',
      'localAmount',

      'discountAmount',
      'discountAmountLocal',
      'discountPercentage',

      'adjustmentLocal',

      'total',
      'totalLocal',
    ];
  }

  /**
   * Detarmines whether the vendor credit is draft.
   * @returns {boolean}
   */
  get isDraft() {
    return !this.openedAt;
  }

  /**
   * Detarmines whether vendor credit is published.
   * @returns {boolean}
   */
  get isPublished() {
    return !!this.openedAt;
  }

  /**
   * Detarmines whether the credit note is open.
   * @return {boolean}
   */
  get isOpen() {
    return !!this.openedAt && moneyGt(this.creditsRemaining, 0);
  }

  /**
   * Detarmines whether the credit note is closed.
   * @return {boolean}
   */
  get isClosed() {
    return this.openedAt && moneyIsZero(this.creditsRemaining);
  }

  /**
   * Retrieve the credits remaining.
   * @returns {number}
   */
  get creditsRemaining() {
    // What is left of the total (after discount and adjustment, the amount
    // the ledger posts), not of the subtotal; VENDOR_CREDIT_REMAINING_SQL is the
    // SQL copy.
    return Math.max(
      subtractMoney(
        this.total,
        sumMoney(this.refundedAmount, this.invoicedAmount),
      ),
      0,
    );
  }

  /**
   * Bill model settings.
   */
  // static get meta() {
  //   return BillSettings;
  // }

  /**
   * Relationship mapping.
   */
  static get relationMappings() {
    const { Vendor } = require('../../Vendors/models/Vendor');
    const {
      ItemEntry,
    } = require('../../TransactionItemEntry/models/ItemEntry');
    const { Branch } = require('../../Branches/models/Branch.model');
    const { Document } = require('../../ChromiumlyTenancy/models/Document');
    const { Warehouse } = require('../../Warehouses/models/Warehouse.model');

    return {
      /**
       * Vendor credit may belongs to vendor.
       */
      vendor: {
        relation: Model.BelongsToOneRelation,
        modelClass: Vendor,
        join: {
          from: 'vendor_credits.vendorId',
          to: 'contacts.id',
        },
        filter(query) {
          query.where('contact_service', 'vendor');
        },
      },

      /**
       * Vendor credit may has many item entries.
       */
      entries: {
        relation: Model.HasManyRelation,
        modelClass: ItemEntry,
        join: {
          from: 'vendor_credits.id',
          to: 'items_entries.referenceId',
        },
        filter(builder) {
          builder.where('reference_type', 'VendorCredit');
          builder.orderBy('index', 'ASC');
        },
      },

      /**
       * Vendor credit may belongs to branch.
       */
      branch: {
        relation: Model.BelongsToOneRelation,
        modelClass: Branch,
        join: {
          from: 'vendor_credits.branchId',
          to: 'branches.id',
        },
      },

      /**
       * Vendor credit may has associated warehouse.
       */
      warehouse: {
        relation: Model.BelongsToOneRelation,
        modelClass: Warehouse,
        join: {
          from: 'vendor_credits.warehouseId',
          to: 'warehouses.id',
        },
      },

      /**
       * Vendor credit may has many attached attachments.
       */
      attachments: {
        relation: Model.ManyToManyRelation,
        modelClass: Document,
        join: {
          from: 'vendor_credits.id',
          through: {
            from: 'document_links.modelId',
            to: 'document_links.documentId',
          },
          to: 'documents.id',
        },
        filter(query) {
          query.where('model_ref', 'VendorCredit');
        },
      },
    };
  }

  /**
   * Model search attributes.
   */
  static get searchRoles() {
    return [
      { fieldKey: 'credit_number', comparator: 'contains' },
      { condition: 'or', fieldKey: 'reference_no', comparator: 'contains' },
      { condition: 'or', fieldKey: 'amount', comparator: 'equals' },
    ];
  }

  /**
   * Prevents mutate base currency since the model is not empty.
   * @returns {boolean}
   */
  static get preventMutateBaseCurrency() {
    return true;
  }
}
