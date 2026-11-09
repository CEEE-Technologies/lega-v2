import { escapePdfCell } from './escape-pdf-cell';
import { escapeTableRows } from '@/modules/FinancialStatements/common/TableSheetPdf';

/** Sweep S5: user text in PDF cells is shown as text, never rendered. */
describe('PDF cells', () => {
  it('escapes HTML in a cell value', () => {
    expect(
      escapePdfCell('<iframe src="http://169.254.169.254/"></iframe>'),
    ).toBe(
      '&lt;iframe src=&quot;http://169.254.169.254/&quot;&gt;&lt;/iframe&gt;',
    );
    expect(escapePdfCell(12.5)).toBe('12.5');
    expect(escapePdfCell(null)).toBe('');
  });

  it('escapes nested report rows too', () => {
    const rows = escapeTableRows([
      {
        cells: [{ key: 'name', value: '<b>Parent</b>' }],
        children: [{ cells: [{ key: 'name', value: '<img src=x>' }] }],
      },
    ]);
    expect(rows[0].cells[0].value).toBe('&lt;b&gt;Parent&lt;/b&gt;');
    expect(rows[0].children[0].cells[0].value).toBe('&lt;img src=x&gt;');
  });
});
