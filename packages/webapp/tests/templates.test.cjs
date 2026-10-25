const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderInvoicePaymentEmail,
} = require('../../../shared/email-components');
const {
  renderInvoicePaperTemplateHtml,
} = require('../../../shared/pdf-templates');

test('transactional email uses LEGA default actions and preserves merchant branding', async () => {
  const html = await renderInvoicePaymentEmail({
    companyName: 'Merchant Example',
    preview: 'Invoice INV-EXAMPLE',
    invoiceNumber: 'INV-EXAMPLE',
    invoiceAmount: '$120.00',
    invoiceMessage: 'Hello Example Customer',
    dueDate: 'November 1, 2026',
    total: '$120.00',
    subtotal: '$120.00',
    dueAmount: '$120.00',
    viewInvoiceButtonUrl: 'https://example.com/invoice',
    items: [],
  });
  assert.match(html, /Merchant Example/);
  assert.match(html, /#1f6f5c/i);
  assert.match(html, /href="https:\/\/example.com\/invoice"/);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /bigcapital/i);
});

test('document defaults use LEGA green and customer overrides remain intact', () => {
  const html = renderInvoicePaperTemplateHtml({
    companyAddress: 'Merchant Example<br />accounts@example.com',
    customerAddress: 'Example Customer<br />customer@example.com',
    lines: [],
  });
  assert.match(html, /Merchant Example/);
  assert.match(html, /--invoice-primary-color: #1f6f5c/i);
  assert.doesNotMatch(html, /bigcapital/i);
  const custom = renderInvoicePaperTemplateHtml({
    companyAddress: 'Merchant Example<br />accounts@example.com',
    primaryColor: '#ab1234',
    lines: [],
  });
  assert.match(custom, /--invoice-primary-color: #ab1234/);
});
