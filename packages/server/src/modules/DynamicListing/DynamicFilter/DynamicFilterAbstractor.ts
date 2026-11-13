import { IDynamicFilter } from './DynamicFilter.types';
import { MetableModel } from '../types/DynamicList.types';
import { relationJoinAlias } from './constants';

export class DynamicFilterAbstractor {
  public model: MetableModel;
  public dynamicFilters: IDynamicFilter[];

  /**
   * Extract relation table name from relation.
   * @param {String} column - Column name
   * @return {String} - join relation table.
   */
  protected getTableFromRelationColumn = (column: string) => {
    const splitedColumn = column.split('.');
    return splitedColumn.length > 0 ? splitedColumn[0] : '';
  };

  /**
   * Builds the relation joins the filters need, once per relation even when
   * several filters (or a view and the filter roles) use it.
   * @param builder - Query builder.
   */
  protected buildFilterRolesJoins = (builder) => {
    const relationKeys = new Set<string>();

    this.dynamicFilters.forEach((dynamicFilter) => {
      dynamicFilter.relationFields.forEach((key) => relationKeys.add(key));
    });
    this.buildFieldsJoinQueries(builder, [...relationKeys]);
  };

  /**
   * Left-joins each relation's table under its filter alias, so rows without
   * the relation still match negative filters ("does not contain").
   * @param builder -
   * @param {string[]} fieldsRelations - Relation keys.
   */
  private buildFieldsJoinQueries = (builder, fieldsRelations: string[]) => {
    fieldsRelations.forEach((fieldRelation) => {
      const relation = this.model.relationMappings[fieldRelation];

      if (relation) {
        const [relationTable, relationColumn] = relation.join.to.split('.');
        const alias = relationJoinAlias(fieldRelation);

        builder.leftJoin(
          `${relationTable} as ${alias}`,
          relation.join.from,
          '=',
          `${alias}.${relationColumn}`,
        );
      }
    });
  };

  /**
   * Retrieve the dynamic filter mode.
   */
  protected getModel() {
    return this.model;
  }
}
