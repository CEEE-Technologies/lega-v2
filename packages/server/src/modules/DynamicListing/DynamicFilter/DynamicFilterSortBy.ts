import { DynamicFilterRoleAbstractor } from './DynamicFilterRoleAbstractor';
import { sanitizeSortDirection } from './sanitizeSortDirection';

interface ISortRole {
  fieldKey: string;
  order: string;
}

export class DynamicFilterSortBy extends DynamicFilterRoleAbstractor {
  private sortRole: ISortRole = {
    fieldKey: '',
    order: '',
  };

  /**
   * Constructor method.
   * @param {string} sortByFieldKey
   * @param {string} sortDirection
   */
  constructor(sortByFieldKey: string, sortDirection: string) {
    super();

    this.sortRole = {
      fieldKey: sortByFieldKey,
      order: sortDirection,
    };
  }

  /**
   * On initialize the dyanmic sort by.
   */
  public onInitialize() {
    this.setRelationIfRelationField(this.sortRole.fieldKey);
  }

  /**
   * Builds database query of sort by column on the given direction.
   */
  public buildQuery = () => {
    const field = this.model.getField(this.sortRole.fieldKey);
    const comparatorColumn = this.getFieldComparatorColumn(field);
    const safeOrder = sanitizeSortDirection(this.sortRole.order);

    // Rows that tie on the sort column (e.g. records imported in the same second)
    // have no fixed order, so pages could repeat or skip rows. Break ties by id.
    const orderByIdTieBreaker = (builder) => {
      builder.orderBy(`${this.tableName}.id`, safeOrder);
    };

    // Sort custom query.
    if (typeof field.sortCustomQuery !== 'undefined') {
      return (builder) => {
        field.sortCustomQuery(builder, { ...this.sortRole, order: safeOrder });
        orderByIdTieBreaker(builder);
      };
    }

    return (builder) => {
      if (this.sortRole.fieldKey) {
        builder.orderBy(`${comparatorColumn}`, safeOrder);
        orderByIdTieBreaker(builder);
      }
    };
  };

  /**
   * Sets response meta.
   */
  public getResponseMeta(): ISortRole {
    return {
      fieldKey: this.sortRole.fieldKey,
      order: this.sortRole.order,
    };
  }
}
