import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentReceivedDto } from '@/modules/PaymentReceived/dtos/PaymentReceived.dto';
import { PaymentReceivedEntryDto } from '@/modules/PaymentReceived/dtos/PaymentReceived.dto';
import { ManualJournalEntryDto } from '@/modules/ManualJournals/dtos/ManualJournal.dto';
import { ItemEntryDto } from '@/modules/TransactionItemEntry/dto/ItemEntry.dto';

const errorsOf = async (cls: any, plain: Record<string, unknown>) => {
  const errors = await validate(plainToInstance(cls, plain) as object);
  return errors.map((error) => error.property);
};

describe('IsMoney — API money fields take at most 2 decimals', () => {
  it('rejects a payment line of 100.005 and accepts 100.01', async () => {
    expect(
      await errorsOf(PaymentReceivedEntryDto, {
        index: 1,
        invoiceId: 1,
        paymentAmount: 100.005,
      }),
    ).toContain('paymentAmount');
    expect(
      await errorsOf(PaymentReceivedEntryDto, {
        index: 1,
        invoiceId: 1,
        paymentAmount: 100.01,
      }),
    ).not.toContain('paymentAmount');
    expect(
      await errorsOf(PaymentReceivedEntryDto, {
        index: 1,
        invoiceId: 1,
        paymentAmount: '1250.75',
      }),
    ).not.toContain('paymentAmount');
  });

  it('rejects a payment amount with 3 decimals', async () => {
    const errors = await errorsOf(CreatePaymentReceivedDto, {
      customerId: 1,
      paymentDate: '2026-01-01',
      depositAccountId: 1,
      amount: 10.001,
      entries: [],
    });
    expect(errors).toContain('amount');
  });

  it('rejects journal debits/credits with 3 decimals', async () => {
    const errors = await errorsOf(ManualJournalEntryDto, {
      index: 1,
      accountId: 1,
      debit: 0.001,
      credit: 0,
    });
    expect(errors).toContain('debit');
    expect(errors).not.toContain('credit');
  });

  it('keeps a line discount of 2.5 (2 decimals) and rejects 2.555', async () => {
    const base = { index: 1, itemId: 1, quantity: 1, rate: 10 };
    expect(
      await errorsOf(ItemEntryDto, { ...base, discount: 2.5 }),
    ).not.toContain('discount');
    expect(
      await errorsOf(ItemEntryDto, { ...base, discount: 2.555 }),
    ).toContain('discount');
    // Unit price is not money: it may keep more decimals.
    expect(
      await errorsOf(ItemEntryDto, { ...base, rate: 10.12345 }),
    ).not.toContain('rate');
  });
});
