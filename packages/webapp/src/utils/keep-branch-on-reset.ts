/**
 * The next state for "Save & New": a fresh form that keeps the branch and
 * warehouse just used. A bare `resetForm()` went back to the initial values,
 * whose branch was filled only once when the form opened, so the next
 * document was sent with no branch (refused, or saved without one).
 */
export const keepBranchAndWarehouse = <V extends object>(
  initialValues: V,
  values: V,
): { values: V } => {
  const kept: Record<string, unknown> = {};
  for (const key of ['branchId', 'warehouseId']) {
    if (key in values) kept[key] = (values as Record<string, unknown>)[key];
  }
  return { values: { ...initialValues, ...kept } };
};
