import { multiplyMoney } from '@bigcapital/utils';
import { BillPaymentAccrualGL } from './BillPaymentAccrualGL';
import { BillPayment } from '../models/BillPayment';

const AP = 100;
const BANK = 200;
const FX = 300;

/**
 * A payment of the vendor opening balance (no bill).
 */
const buildOpeningBalancePayment = (amount: number, exchangeRate: number) =>
  ({
    id: 1,
    vendorId: 7,
    currencyCode: 'EUR',
    exchangeRate,
    amount,
    localAmount: amount * exchangeRate,
    paymentAccountId: BANK,
    paymentDate: '2026-06-01',
    entries: [
      {
        entryType: 'opening_balance',
        billId: null,
        bill: null,
        paymentAmount: amount,
      },
    ],
  }) as unknown as BillPayment;

const glOf = (
  payment: BillPayment,
  openingBalance: { exchangeRate: number; paidBefore: number } | null,
) =>
  new BillPaymentAccrualGL(payment)
    .setOpeningBalance(openingBalance)
    .setAPAccountId(AP)
    .setGainLossAccountId(FX)
    .setBaseCurrency('USD')
    .getBillPaymentLedger()
    .getEntries();

/** Net A/P movement (debit - credit). */
const apNet = (entries: any[]) =>
  Math.round(
    entries
      .filter((e) => e.accountId === AP)
      .reduce((sum, e) => sum + (e.debit || 0) - (e.credit || 0), 0) * 100,
  ) / 100;

describe('BillPaymentAccrualGL: opening balance lines', () => {
  it('relieves A/P at the opening balance rate and posts the exchange loss', () => {
    // EUR 100 opening balance posted at 1.2 (A/P 120), paid at 1.3: the
    // payment costs 130, so 10 is an exchange loss.
    const entries = glOf(buildOpeningBalancePayment(100, 1.3), {
      exchangeRate: 1.2,
      paidBefore: 0,
    });

    expect(apNet(entries)).toBe(120);
    expect(entries.find((e) => e.accountId === BANK).credit).toBe(130);

    const loss = entries.find((e) => e.accountId === FX);
    expect(loss.debit).toBe(10);
    expect(loss.credit).toBe(0);
  });

  it('posts an exchange gain when paid at a lower rate', () => {
    const entries = glOf(buildOpeningBalancePayment(100, 1.1), {
      exchangeRate: 1.2,
      paidBefore: 0,
    });
    expect(apNet(entries)).toBe(120);
    expect(entries.find((e) => e.accountId === FX).credit).toBe(10);
  });

  it('relieves A/P as a running total, so parts add up to the posted amount', () => {
    const reliefs = [0, 0.01, 0.02].map((paidBefore) =>
      apNet(
        glOf(buildOpeningBalancePayment(0.01, 1.5), {
          exchangeRate: 1.5,
          paidBefore,
        }),
      ),
    );
    const total = Math.round(reliefs.reduce((a, b) => a + b, 0) * 100) / 100;
    // The EUR 0.03 opening balance at 1.5, as posted.
    expect(total).toBe(multiplyMoney(0.03, 1.5));
  });
});
