import { test, expect, type Page } from '@playwright/test';
import {
  api,
  createCustomer,
  createItem,
  createVendor,
  expectInputValue,
  setAutoNumbering,
  settle,
  today,
  uniqueTag,
} from './_screens';

/**
 * F3: opening an existing credit note, vendor credit or warehouse transfer
 * for editing keeps its own number, with auto-numbering on and off.
 */

let customerId: number;
let vendorId: number;
let serviceItemId: number;
let inventoryItemId: number;
let fromWarehouseId: number;
let toWarehouseId: number;

test.beforeAll(async () => {
  const tag = uniqueTag();
  customerId = await createCustomer(`E2E Numbers Customer ${tag}`);
  vendorId = await createVendor(`E2E Numbers Vendor ${tag}`);
  serviceItemId = await createItem(`E2E Numbers Service ${tag}`);
  inventoryItemId = await createItem(`E2E Numbers Stock ${tag}`, 'inventory');

  // Warehouse transfers need the warehouses feature and two warehouses.
  await api('POST', '/warehouses/activate').catch(() => undefined);
  const warehouses = async () => {
    const res = await api('GET', '/warehouses');
    return (res.data ?? res.warehouses ?? res) as any[];
  };
  while ((await warehouses()).length < 2) {
    await api('POST', '/warehouses', {
      name: `E2E WH ${uniqueTag()}`,
      code: uniqueTag(),
    });
  }
  const [first, second] = await warehouses();
  fromWarehouseId = first.id;
  toWarehouseId = second.id;
});

interface DocumentType {
  name: string;
  settingsGroup: string;
  numberField: string;
  create: (number: string) => Promise<number>;
  editUrl: (id: number) => string;
  fetchNumber: (id: number) => Promise<string>;
}

const DOCUMENTS: DocumentType[] = [
  {
    name: 'credit note',
    settingsGroup: 'credit_note',
    numberField: 'creditNoteNumber',
    create: async (creditNoteNumber) =>
      (
        await api('POST', '/credit-notes', {
          customerId,
          creditNoteDate: today(),
          creditNoteNumber,
          open: false,
          entries: [{ index: 1, itemId: serviceItemId, quantity: 1, rate: 50 }],
        })
      ).id,
    editUrl: (id) => `/credit-notes/${id}/edit`,
    fetchNumber: async (id) =>
      (await api('GET', `/credit-notes/${id}`)).credit_note_number,
  },
  {
    name: 'vendor credit',
    settingsGroup: 'vendor_credit',
    numberField: 'vendorCreditNumber',
    create: async (vendorCreditNumber) =>
      (
        await api('POST', '/vendor-credits', {
          vendorId,
          vendorCreditDate: today(),
          vendorCreditNumber,
          open: false,
          entries: [{ index: 1, itemId: serviceItemId, quantity: 1, rate: 50 }],
        })
      ).id,
    editUrl: (id) => `/vendor-credits/${id}/edit`,
    fetchNumber: async (id) =>
      (await api('GET', `/vendor-credits/${id}`)).vendor_credit_number,
  },
  {
    name: 'warehouse transfer',
    settingsGroup: 'warehouse_transfers',
    numberField: 'transactionNumber',
    create: async (transactionNumber) =>
      (
        await api('POST', '/warehouse-transfers', {
          fromWarehouseId,
          toWarehouseId,
          date: today(),
          transactionNumber,
          entries: [{ index: 1, itemId: inventoryItemId, quantity: 1 }],
        })
      ).id,
    editUrl: (id) => `/warehouses-transfers/${id}/edit`,
    fetchNumber: async (id) =>
      (await api('GET', `/warehouse-transfers/${id}`)).transaction_number,
  },
];

async function saveDraft(page: Page) {
  const saveDraft = page.getByRole('button', { name: 'Save as Draft' });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await ((await saveDraft.isVisible()) ? saveDraft : save).first().click();
}

for (const doc of DOCUMENTS) {
  for (const autoIncrement of [true, false]) {
    test(`editing a ${doc.name} keeps its number (auto-numbering ${
      autoIncrement ? 'on' : 'off'
    })`, async ({ page }) => {
      await setAutoNumbering(doc.settingsGroup, autoIncrement);
      const number = `KEEP-${uniqueTag()}`;
      const id = await doc.create(number);

      await page.goto(doc.editUrl(id));
      await expectInputValue(page, doc.numberField, number);
      await settle(page);
      // Still the document's own number once everything has loaded.
      await expectInputValue(page, doc.numberField, number);

      const saved = page.waitForResponse((res) =>
        res.request().method() === 'PUT' || res.request().method() === 'POST'
          ? res.url().includes(`/${id}`)
          : false,
      );
      await saveDraft(page);
      expect((await saved).ok()).toBe(true);

      expect(await doc.fetchNumber(id)).toBe(number);
    });
  }

  test(`a new ${doc.name} gets the next number`, async ({ page }) => {
    const prefix = `N${uniqueTag()}-`;
    await setAutoNumbering(doc.settingsGroup, true, prefix, 77);

    await page.goto(doc.editUrl(0).replace('/0/edit', '/new'));
    await expectInputValue(page, doc.numberField, `${prefix}77`);
  });
}
