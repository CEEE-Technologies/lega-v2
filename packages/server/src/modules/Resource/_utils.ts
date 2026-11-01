import { camelCase, upperFirst } from 'lodash';
import * as pluralize from 'pluralize';

/**
 * Resources whose model is registered under a different name.
 * The webapp asks for "tax-rate" / "tax_rate" (→ "TaxRate"), but the model
 * is registered as "TaxRateModel".
 */
const RESOURCE_MODEL_ALIASES: Record<string, string> = {
  TaxRate: 'TaxRateModel',
};

export const resourceToModelName = (resourceName: string): string => {
  const modelName = upperFirst(camelCase(pluralize.singular(resourceName)));

  return RESOURCE_MODEL_ALIASES[modelName] ?? modelName;
};
