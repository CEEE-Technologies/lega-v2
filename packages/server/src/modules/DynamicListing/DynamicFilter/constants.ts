export const COMPARATOR_TYPE = {
  EQUAL: 'equal',
  EQUALS: 'equals',

  NOT_EQUAL: 'not_equal',
  NOT_EQUALS: 'not_equals',

  BIGGER_THAN: 'bigger_than',
  BIGGER: 'bigger',
  BIGGER_OR_EQUALS: 'bigger_or_equals',
  BIGGER_OR_EQUAL: 'bigger_or_equal',

  SMALLER_THAN: 'smaller_than',
  SMALLER: 'smaller',
  SMALLER_OR_EQUALS: 'smaller_or_equals',
  SMALLER_OR_EQUAL: 'smaller_or_equal',

  IS: 'is',
  IS_NOT: 'is_not',

  CONTAINS: 'contains',
  CONTAIN: 'contain',
  NOT_CONTAINS: 'not_contains',
  NOT_CONTAIN: 'not_contain',

  AFTER: 'after',
  BEFORE: 'before',
  IN: 'in',

  STARTS_WITH: 'starts_with',
  START_WITH: 'start_with',

  ENDS_WITH: 'ends_with',
  END_WITH: 'end_with',
};

export const FIELD_TYPE = {
  TEXT: 'text',
  NUMBER: 'number',
  ENUMERATION: 'enumeration',
  BOOLEAN: 'boolean',
  RELATION: 'relation',
  DATE: 'date',
  COMPUTED: 'computed',
};

/**
 * Comparators that negate an enumeration or boolean match ("is not").
 */
export const NEGATIVE_COMPARATORS = [
  COMPARATOR_TYPE.IS_NOT,
  COMPARATOR_TYPE.NOT_EQUAL,
  COMPARATOR_TYPE.NOT_EQUALS,
];

/**
 * The alias a filter gives the table it joins for a relation field, so two
 * relations to the same table (e.g. an item's cost and sell accounts) don't
 * clash.
 */
export const relationJoinAlias = (relationKey: string) =>
  `filter_${relationKey}`;
