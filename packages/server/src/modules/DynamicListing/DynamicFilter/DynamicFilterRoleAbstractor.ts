import * as moment from 'moment';
import { IFilterRole, IDynamicFilter } from './DynamicFilter.types';
import { Parser } from '@/libs/logic-evaluation/Parser';
import { Lexer } from '@/libs/logic-evaluation/Lexer';
import { DynamicFilterQueryParser } from './DynamicFilterQueryParser';
import { numberOperator } from './rawNumberFilterQuery';
import {
  COMPARATOR_TYPE,
  FIELD_TYPE,
  NEGATIVE_COMPARATORS,
  relationJoinAlias,
} from './constants';
import { BaseModel } from '@/models/Model';
import { IModelMetaRelationField } from '@/interfaces/Model';
import { MetableModel } from '../types/DynamicList.types';
import { Knex } from 'knex';

/**
 * Negative text comparators and the positive comparator they negate.
 */
const NEGATIVE_TEXT_COMPARATORS: Record<string, string> = {
  [COMPARATOR_TYPE.NOT_CONTAIN]: COMPARATOR_TYPE.CONTAIN,
  [COMPARATOR_TYPE.NOT_CONTAINS]: COMPARATOR_TYPE.CONTAINS,
  [COMPARATOR_TYPE.NOT_EQUAL]: COMPARATOR_TYPE.EQUAL,
  [COMPARATOR_TYPE.NOT_EQUALS]: COMPARATOR_TYPE.EQUALS,
  [COMPARATOR_TYPE.IS_NOT]: COMPARATOR_TYPE.IS,
};

const FILTER_DATETIME_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/**
 * Parses a filter date value. The filter popover sends `YYYY/MM/DD`; stored
 * views and API callers may send `YYYY-MM-DD`, with or without a time.
 */
export const parseFilterDate = (value: unknown) => {
  const text = String(value ?? '').trim();
  const withTime = moment(
    text,
    [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD HH:mm',
      'YYYY/MM/DD HH:mm:ss',
      'YYYY/MM/DD HH:mm',
      'YYYY-MM-DDTHH:mm:ss',
      'YYYY-MM-DDTHH:mm',
    ],
    true,
  );
  if (withTime.isValid()) {
    return { date: withTime, hasTime: true };
  }
  return {
    date: moment(text, ['YYYY-MM-DD', 'YYYY/MM/DD'], true),
    hasTime: false,
  };
};

export abstract class DynamicFilterRoleAbstractor implements IDynamicFilter {
  public filterRoles: IFilterRole[] = [];
  public tableName: string;
  public model: MetableModel;
  public responseMeta: { [key: string]: any } = {};
  public relationFields = [];

  /**
   * Sets model the dynamic filter service.
   * @param {IModel} model
   */
  public setModel(model: MetableModel) {
    this.model = model;
    this.tableName = model.tableName;
  }

  /**
   * Transformes filter roles to map by index.
   * @param {IModel} model
   * @param {IFilterRole[]} roles
   * @returns
   */
  protected convertRolesMapByIndex = (model, roles) => {
    const rolesIndexSet = {};

    roles.forEach((role) => {
      rolesIndexSet[role.index] = this.buildRoleQuery(model, role);
    });
    return rolesIndexSet;
  };

  /**
   * Builds database query from stored view roles.
   * @param {Array} roles -
   * @return {Function}
   */
  protected buildFilterRolesQuery = (
    model: typeof BaseModel,
    roles: IFilterRole[],
    logicExpression: string = '',
  ) => {
    const rolesIndexSet = this.convertRolesMapByIndex(model, roles);

    // Lexer for logic expression.
    const lexer = new Lexer(logicExpression);
    const tokens = lexer.getTokens();

    // Parse the logic expression.
    const parser = new Parser(tokens);
    const parsedTree = parser.parse();

    const queryParser = new DynamicFilterQueryParser(parsedTree, rolesIndexSet);

    return queryParser.parse();
  };

  /**
   * Parses the logic expression to base expression.
   * @param {string} logicExpression -
   * @return {string}
   */
  private parseLogicExpression(logicExpression: string): string {
    return logicExpression.replace(/or|OR/g, '||').replace(/and|AND/g, '&&');
  }

  /**
   * Builds filter query for query builder.
   * @param {String} tableName - Table name.
   * @param {Array} roles - Filter roles.
   * @param {String} logicExpression - Logic expression.
   */
  protected buildFilterQuery = (
    model: typeof BaseModel,
    roles: IFilterRole[],
    logicExpression: string,
  ) => {
    const basicExpression = this.parseLogicExpression(logicExpression);

    return (builder) => {
      this.buildFilterRolesQuery(model, roles, basicExpression)(builder);
    };
  };

  /**
   * Retrieve the relation column a relation field sorts on: the related
   * record's label (e.g. the customer's display name) on the table joined
   * under the relation's alias.
   */
  protected getFieldComparatorRelationColumn(field: any): string {
    const relation = this.model.relationMappings[field.relationKey];

    if (relation) {
      return `${relationJoinAlias(field.relationKey)}.${this.getRelationLabelColumn(field)}`;
    }
  }

  /**
   * Retrieve the label column of a relation field's related model.
   */
  protected getRelationLabelColumn(field: any): string {
    const relationModel =
      this.model.relationMappings[field.relationKey]?.modelClass;
    const labelKey = field.relationEntityLabel || field.relationEntityKey;

    return (
      (typeof relationModel?.getField === 'function' &&
        relationModel.getField(labelKey, 'column')) ||
      labelKey
    );
  }

  /**
   * Relation field query. The filter popover offers a text box for relation
   * fields, so the typed text is matched against the related record's label
   * (e.g. the customer's display name), through a subquery on the related
   * table: `customer_id IN (SELECT id FROM contacts WHERE display_name ...)`.
   * A negative comparator keeps the rows that have no related record.
   */
  protected relationRoleQueryBuilder = (field: any, role: IFilterRole) => {
    const relation = this.model.relationMappings[field.relationKey];

    if (!relation) {
      return (builder) => builder.whereRaw('1 = 0');
    }
    const [relationTable, relationColumn] = relation.join.to.split('.');
    const fromColumn = relation.join.from;
    const positiveComparator = NEGATIVE_TEXT_COMPARATORS[role.comparator];
    const labelQuery = this.textRoleQueryBuilder(
      { ...role, comparator: positiveComparator || role.comparator },
      `${relationTable}.${this.getRelationLabelColumn(field)}`,
    );
    const subquery = (query) => {
      query.select(`${relationTable}.${relationColumn}`).from(relationTable);
      labelQuery(query);
    };
    return (builder) => {
      if (positiveComparator) {
        builder.where((query) =>
          query.whereNotIn(fromColumn, subquery).orWhereNull(fromColumn),
        );
      } else {
        builder.whereIn(fromColumn, subquery);
      }
    };
  };

  /**
   * Retrieve the comparator field column.
   * @param {IModel} model -
   * @param {} -
   */
  protected getFieldComparatorColumn = (field) => {
    return field.fieldType === FIELD_TYPE.RELATION
      ? this.getFieldComparatorRelationColumn(field)
      : `${this.tableName}.${field.column}`;
  };

  /**
   * Builds roles queries.
   * @param {IModel} model -
   * @param {Object} role -
   */
  protected buildRoleQuery = (model: MetableModel, role: IFilterRole) => {
    const field = model.getField(role.fieldKey);
    const comparatorColumn = this.getFieldComparatorColumn(field);

    // Field custom query (a status, a computed amount). It runs in its own
    // subquery on the list's table: `id IN (SELECT id FROM <table> WHERE
    // ...)`. Custom queries name columns without their table (e.g. BALANCE),
    // and a sort by a relation joins another table that may have a column of
    // the same name (contacts.BALANCE), which made the list query ambiguous.
    // An enumeration's "is not" negates the custom match; number, date and
    // text custom queries handle the comparator themselves.
    if (typeof field.filterCustomQuery !== 'undefined') {
      const negate =
        ![FIELD_TYPE.NUMBER, FIELD_TYPE.DATE, FIELD_TYPE.TEXT].includes(
          field.fieldType,
        ) && NEGATIVE_COMPARATORS.includes(role.comparator);
      const idColumn = `${this.tableName}.id`;

      return (builder) => {
        const customQuery = (query) => {
          query.select(idColumn).from(this.tableName);
          field.filterCustomQuery(query, role);
        };
        if (negate) {
          builder.whereNotIn(idColumn, customQuery);
        } else {
          builder.whereIn(idColumn, customQuery);
        }
      };
    }
    switch (field.fieldType) {
      case FIELD_TYPE.RELATION:
        return this.relationRoleQueryBuilder(field, role);
      case FIELD_TYPE.BOOLEAN:
      case FIELD_TYPE.ENUMERATION:
        return this.booleanRoleQueryBuilder(role, comparatorColumn);
      case FIELD_TYPE.NUMBER:
        return this.numberRoleQueryBuilder(role, comparatorColumn);
      case FIELD_TYPE.DATE:
        return this.dateQueryBuilder(role, comparatorColumn);
      case FIELD_TYPE.TEXT:
      default:
        return this.textRoleQueryBuilder(role, comparatorColumn);
    }
  };

  /**
   * Boolean column query builder.
   * @param {IFilterRole} role
   * @param {string} comparatorColumn
   * @returns
   */
  protected booleanRoleQueryBuilder = (
    role: IFilterRole,
    comparatorColumn: string,
  ) => {
    switch (role.comparator) {
      case COMPARATOR_TYPE.EQUALS:
      case COMPARATOR_TYPE.EQUAL:
      case COMPARATOR_TYPE.IS:
      default:
        return (builder) => {
          builder.where(comparatorColumn, '=', role.value);
        };
      case COMPARATOR_TYPE.NOT_EQUAL:
      case COMPARATOR_TYPE.NOT_EQUALS:
      case COMPARATOR_TYPE.IS_NOT:
        return (builder) => {
          builder.where(comparatorColumn, '<>', role.value);
        };
    }
  };

  /**
   * Numeric column query builder. An empty (NULL) amount counts as 0, as the
   * lists show it, so a comparator and its opposite cover every row.
   * @param {IFilterRole} role
   * @param {string} comparatorColumn
   * @returns
   */
  protected numberRoleQueryBuilder = (
    role: IFilterRole,
    comparatorColumn: string,
  ) => {
    const value = Number(role.value);
    const operator = numberOperator(role.comparator);

    return (builder) => {
      if (role.value === '' || role.value === null || Number.isNaN(value)) {
        builder.whereRaw('1 = 0');
        return;
      }
      builder.whereRaw(`COALESCE(??, 0) ${operator} ?`, [
        comparatorColumn,
        value,
      ]);
    };
  };

  /**
   * Text column query builder.
   * @param {IFilterRole} role
   * @param {string} comparatorColumn
   * @returns {Function}
   */
  protected textRoleQueryBuilder = (
    role: IFilterRole,
    comparatorColumn: string,
  ) => {
    switch (role.comparator) {
      case COMPARATOR_TYPE.EQUAL:
      case COMPARATOR_TYPE.EQUALS:
      case COMPARATOR_TYPE.IS:
      default:
        return (builder) => {
          builder.where(comparatorColumn, role.value);
        };
      case COMPARATOR_TYPE.NOT_EQUALS:
      case COMPARATOR_TYPE.NOT_EQUAL:
      case COMPARATOR_TYPE.IS_NOT:
        return (builder) => {
          builder.where((query) =>
            query
              .whereNot(comparatorColumn, role.value)
              .orWhereNull(comparatorColumn),
          );
        };
      case COMPARATOR_TYPE.CONTAIN:
      case COMPARATOR_TYPE.CONTAINS:
        return (builder) => {
          builder.where(comparatorColumn, 'LIKE', `%${role.value}%`);
        };
      case COMPARATOR_TYPE.NOT_CONTAIN:
      case COMPARATOR_TYPE.NOT_CONTAINS:
        return (builder) => {
          builder.where((query) =>
            query
              .whereNot(comparatorColumn, 'LIKE', `%${role.value}%`)
              .orWhereNull(comparatorColumn),
          );
        };
      case COMPARATOR_TYPE.STARTS_WITH:
      case COMPARATOR_TYPE.START_WITH:
        return (builder) => {
          builder.where(comparatorColumn, 'LIKE', `${role.value}%`);
        };
      case COMPARATOR_TYPE.ENDS_WITH:
      case COMPARATOR_TYPE.END_WITH:
        return (builder) => {
          builder.where(comparatorColumn, 'LIKE', `%${role.value}`);
        };
    }
  };

  /**
   * Date column query builder.
   * @param {IFilterRole} role
   * @param {string} comparatorColumn
   * @returns {Function}
   */
  protected dateQueryBuilder = (
    role: IFilterRole,
    comparatorColumn: string,
  ) => {
    switch (role.comparator) {
      case COMPARATOR_TYPE.AFTER:
      case COMPARATOR_TYPE.BEFORE:
        return (builder) => {
          this.dateQueryAfterBeforeComparator(role, comparatorColumn, builder);
        };
      case COMPARATOR_TYPE.IN:
      default:
        return (builder) => {
          this.dateQueryInComparator(role, comparatorColumn, builder);
        };
    }
  };

  /**
   * Date query 'IN' comparator type: the whole day, or the whole minute when
   * the value carries a time.
   * @param {IFilterRole} role
   * @param {string} comparatorColumn
   * @param builder
   */
  protected dateQueryInComparator = (
    role: IFilterRole,
    comparatorColumn: string,
    builder,
  ) => {
    const { date, hasTime } = parseFilterDate(role.value);

    if (!date.isValid()) {
      builder.whereRaw('1 = 0');
      return;
    }
    const unit = hasTime ? 'minute' : 'day';
    const startDate = date.clone().startOf(unit).format(FILTER_DATETIME_FORMAT);
    const endDate = date.clone().endOf(unit).format(FILTER_DATETIME_FORMAT);

    builder.where(comparatorColumn, '>=', startDate);
    builder.where(comparatorColumn, '<=', endDate);
  };

  /**
   * Date query after/before comparator type. A date without a time means
   * after the end of that day, or before its start.
   * @param {IFilterRole} role
   * @param {string} comparatorColumn - Column.
   * @param builder
   */
  protected dateQueryAfterBeforeComparator = (
    role: IFilterRole,
    comparatorColumn: string,
    builder,
  ) => {
    const isBefore = role.comparator === COMPARATOR_TYPE.BEFORE;
    const { date, hasTime } = parseFilterDate(role.value);

    if (!date.isValid()) {
      builder.whereRaw('1 = 0');
      return;
    }
    if (!hasTime) {
      date[isBefore ? 'startOf' : 'endOf']('day');
    }
    builder.where(
      comparatorColumn,
      isBefore ? '<' : '>',
      date.format(FILTER_DATETIME_FORMAT),
    );
  };

  /**
   * Registers relation field if the given field was relation type and not
   * registered yet.
   * @param {string} fieldKey - Field key.
   */
  protected setRelationIfRelationField = (fieldKey: string): void => {
    const field = this.model.getField(fieldKey);

    if (!field || field.fieldType !== FIELD_TYPE.RELATION) return;

    const { relationKey } = field as IModelMetaRelationField;

    if (!this.relationFields.includes(relationKey)) {
      this.relationFields.push(relationKey);
    }
  };

  /**
   * Retrieve the model.
   */
  getModel() {
    return this.model;
  }

  /**
   * On initialize the registered dynamic filter.
   */
  onInitialize() {}

  /**
   * Builds the query.
   */
  buildQuery(): (builder: Knex.QueryBuilder) => void {
    throw new Error('Method not implemented.');
  }

  /**
   * Retrieves the response meta.
   */
  getResponseMeta(): Record<string, any> {
    return this.responseMeta;
  }
}
