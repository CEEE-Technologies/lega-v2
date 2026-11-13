import { DynamicFilterRoleAbstractor } from './DynamicFilterRoleAbstractor';

export class DynamicFilterFilterRoles extends DynamicFilterRoleAbstractor {
  /**
   * Builds filter roles logic expression.
   * @return {string}
   */
  private buildLogicExpression(): string {
    let expression = '';

    this.filterRoles.forEach((role, index) => {
      expression +=
        index === 0 ? `${role.index} ` : `${role.condition} ${role.index} `;
    });
    return expression.trim();
  }

  /**
   * Builds database query of view roles.
   */
  public buildQuery() {
    const logicExpression = this.buildLogicExpression();

    return (builder) => {
      this.buildFilterQuery(
        this.model,
        this.filterRoles,
        logicExpression,
      )(builder);
    };
  }
}
