import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createCustomer,
  createServiceItem,
  createVendor,
  expectBalanced,
  fetchLegs,
  getBaseCurrency,
  GLTestLeg,
  sumCredits,
  sumDebits,
} from './_utils/gl';

/**
 * Editing a published credit note (or vendor credit) rewrites its ledger.
 *
 * The edit handler read `isPublished` from the partial graph the edit saved,
 * which has no `openedAt` unless the edit itself publishes. So a published
 * credit note edited from 100.00 to 80.00 kept its 100.00 ledger lines.
 */
interface Side {
  label: string;
  path: string;
  referenceType: string;
  // The contact leg: the customer's A/R is credited, the vendor's A/P debited.
  contactLegSide: 'credit' | 'debit';
  createContact: (currencyCode: string) => Promise<number>;
  body: (contactId: number, overrides: Record<string, any>) => any;
}

const ensureCurrency = async (currencyCode: string) => {
  const res = await request(app.getHttpServer())
    .get(`/currencies/${currencyCode}`)
    .set(authHeaders());
  if (res.status === 200 && res.body) return;
  await request(app.getHttpServer())
    .post('/currencies')
    .set(authHeaders())
    .send({
      currencyCode,
      currencyName: currencyCode,
      currencySign: currencyCode,
    });
};

let itemId: number;

const entries = (rate: number) => [
  { index: 1, itemId, quantity: 1, rate, description: 'Returned goods.' },
];

const SIDES: Side[] = [
  {
    label: 'credit note',
    path: '/credit-notes',
    referenceType: 'CreditNote',
    contactLegSide: 'credit',
    createContact: createCustomer,
    body: (customerId, { rate, ...overrides }) => ({
      customerId,
      creditNoteDate: '2026-10-15',
      entries: entries(rate),
      ...overrides,
    }),
  },
  {
    label: 'vendor credit',
    path: '/vendor-credits',
    referenceType: 'VendorCredit',
    contactLegSide: 'debit',
    createContact: createVendor,
    body: (vendorId, { rate, ...overrides }) => ({
      vendorId,
      vendorCreditNumber: faker.string.uuid(),
      vendorCreditDate: '2026-10-15',
      entries: entries(rate),
      ...overrides,
    }),
  },
];

describe.each(SIDES)('Ledger of an edited $label (e2e)', (side) => {
  let baseCurrency: string;
  let contactId: number;

  beforeAll(async () => {
    await cancelTransactionsLock();
    baseCurrency = await getBaseCurrency();
    itemId = await createServiceItem();
    contactId = await side.createContact(baseCurrency);
  });

  const create = async (cId: number, overrides: Record<string, any>) => {
    const res = await request(app.getHttpServer())
      .post(side.path)
      .set(authHeaders())
      .send(side.body(cId, overrides))
      .expect(201);
    return res.body.id as number;
  };

  const edit = async (
    id: number,
    cId: number,
    overrides: Record<string, any>,
  ) => {
    await request(app.getHttpServer())
      .put(`${side.path}/${id}`)
      .set(authHeaders())
      .send(side.body(cId, overrides))
      .expect(200);
  };

  const legsOf = (id: number) => fetchLegs(side.referenceType, id);

  const contactLeg = (legs: GLTestLeg[], cId: number) =>
    legs.find(
      (leg) => leg.contactId === cId && leg[side.contactLegSide].amount,
    );

  /**
   * The journal has the given total on both sides, and the contact leg
   * carries all of it.
   */
  const expectJournal = (legs: GLTestLeg[], cId: number, total: number) => {
    expectBalanced(legs);
    expect(sumDebits(legs)).toBeCloseTo(total, 2);
    expect(sumCredits(legs)).toBeCloseTo(total, 2);
    expect(contactLeg(legs, cId)?.[side.contactLegSide].amount).toBeCloseTo(
      total,
      2,
    );
  };

  it('editing a published one from 100.00 to 80.00 rewrites its ledger to 80.00', async () => {
    const id = await create(contactId, { rate: 100, open: true });
    expectJournal(await legsOf(id), contactId, 100);

    await edit(id, contactId, { rate: 80 });

    expectJournal(await legsOf(id), contactId, 80);
  });

  it('editing a draft writes no ledger', async () => {
    const id = await create(contactId, { rate: 100 });
    expect(await legsOf(id)).toHaveLength(0);

    await edit(id, contactId, { rate: 80 });

    expect(await legsOf(id)).toHaveLength(0);
  });

  it('publishing a draft on edit writes the edited amount', async () => {
    const id = await create(contactId, { rate: 100 });

    await edit(id, contactId, { rate: 80, open: true });

    expectJournal(await legsOf(id), contactId, 80);
  });

  it('editing a published one twice keeps a single journal', async () => {
    const id = await create(contactId, { rate: 100, open: true });

    await edit(id, contactId, { rate: 80 });
    await edit(id, contactId, { rate: 60 });

    const legs = await legsOf(id);
    expectJournal(legs, contactId, 60);
    expect(legs.filter((leg) => leg.contactId === contactId)).toHaveLength(1);
  });

  it('editing a foreign currency one rewrites its ledger at the new amount and rate', async () => {
    await ensureCurrency('EUR');
    const eurContactId = await side.createContact('EUR');
    const id = await create(eurContactId, {
      rate: 100,
      exchangeRate: 2,
      open: true,
    });
    expectJournal(await legsOf(id), eurContactId, 200);

    await edit(id, eurContactId, { rate: 80, exchangeRate: 3 });

    expectJournal(await legsOf(id), eurContactId, 240);
  });

  it('deleting an edited one removes its whole ledger', async () => {
    const id = await create(contactId, { rate: 100, open: true });
    await edit(id, contactId, { rate: 80 });

    await request(app.getHttpServer())
      .delete(`${side.path}/${id}`)
      .set(authHeaders())
      .expect(200);

    expect(await legsOf(id)).toHaveLength(0);
  });
});
