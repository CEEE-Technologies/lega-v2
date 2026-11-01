import { multiplyMoney } from '@bigcapital/utils';
import { PaymentReceivedAccrualGL } from './PaymentReceivedAccrualGL';
import { PaymentReceived } from '../models/PaymentReceived';

const AR = 100;
const BANK = 200;
const FX = 300;

/**
 * A payment of the customer opening balance (no invoice).
 */
const buildOpeningBalancePayment = (amount: number, exchangeRate: number) =>
  ({
    id: 1,
    customerId: 7,
    currencyCode: 'EUR',
    exchangeRate,
    amount,
    localAmount: amount * exchangeRate,
    depositAccountId: BANK,
    paymentDate: '2026-06-01',
    entries: [
      {
        entryType: 'opening_balance',
        invoiceId: null,
        invoice: null,
        paymentAmount: amount,
      },
    ],
  }) as unknown as PaymentReceived;

const glOf = (
  payment: PaymentReceived,
  openingBalance: { exchangeRate: number; paidBefore: number } | null,
) =>
  new PaymentReceivedAccrualGL(payment)
    .setOpeningBalance(openingBalance)
    .setARAccountId(AR)
    .setExchangeGainOrLossAccountId(FX)
    .setBaseCurrencyCode('USD')
    .GLEntries();

/** Net A/R movement (debit - credit). */
const arNet = (entries: any[]) =>
  Math.round(
    entries
      .filter((e) => e.accountId === AR)
      .reduce((sum, e) => sum + (e.debit || 0) - (e.credit || 0), 0) * 100,
  ) / 100;

describe('PaymentReceivedAccrualGL: opening balance lines', () => {
  it('relieves A/R at the opening balance rate and posts the exchange gain', () => {
    // EUR 100 opening balance posted at 1.2 (A/R 120), paid at 1.3.
    const entries = glOf(buildOpeningBalancePayment(100, 1.3), {
      exchangeRate: 1.2,
      paidBefore: 0,
    });

    expect(arNet(entries)).toBe(-120);
    expect(entries.find((e) => e.accountId === BANK).debit).toBe(130);

    const gain = entries.find((e) => e.accountId === FX);
    expect(gain.credit).toBe(10);
    expect(gain.debit).toBe(0);
  });

  it('posts an exchange loss when paid at a lower rate', () => {
    const entries = glOf(buildOpeningBalancePayment(100, 1.1), {
      exchangeRate: 1.2,
      paidBefore: 0,
    });
    expect(arNet(entries)).toBe(-120);
    expect(entries.find((e) => e.accountId === FX).debit).toBe(10);
  });

  it('posts no exchange line at the opening balance rate', () => {
    const entries = glOf(buildOpeningBalancePayment(100, 1.2), {
      exchangeRate: 1.2,
      paidBefore: 0,
    });
    expect(arNet(entries)).toBe(-120);
    expect(entries.find((e) => e.accountId === FX)).toBeUndefined();
  });

  it('relieves A/R as a running total, so parts add up to the posted amount', () => {
    // EUR 0.03 opening balance at 1.5, paid EUR 0.01 three times.
    const reliefs = [0, 0.01, 0.02].map((paidBefore) =>
      arNet(
        glOf(buildOpeningBalancePayment(0.01, 1.5), {
          exchangeRate: 1.5,
          paidBefore,
        }),
      ),
    );
    const total = Math.round(reliefs.reduce((a, b) => a + b, 0) * 100) / 100;
    // The EUR 0.03 opening balance at 1.5, as posted.
    expect(total).toBe(-multiplyMoney(0.03, 1.5));
  });

  it('keeps the old behaviour without the opening balance rate', () => {
    const entries = glOf(buildOpeningBalancePayment(100, 1.3), null);
    expect(arNet(entries)).toBe(-130);
    expect(entries.find((e) => e.accountId === FX)).toBeUndefined();
  });
});
