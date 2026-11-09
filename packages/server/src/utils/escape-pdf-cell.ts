import { escape } from 'lodash';

/**
 * A cell value as HTML text for the PDF templates, which render cells as
 * raw HTML (`dangerouslySetInnerHTML`, for the indent of nested report
 * rows). User text (customer, item, account names...) is escaped, so a
 * name like `<iframe src=...>` is shown as text, not rendered by the PDF
 * service.
 */
export const escapePdfCell = (value: unknown): string =>
  value === null || value === undefined ? '' : escape(String(value));
