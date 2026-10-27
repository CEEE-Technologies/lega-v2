import { DiscountType } from '@/common/types/Discount';
import { ItemEntry } from './ItemEntry';

describe('ItemEntry.calcAmount', () => {
  it('returns the gross amount when no discount is set', () => {
    expect(ItemEntry.calcAmount({ quantity: 2, rate: 1000 })).toBe(2000);
    expect(ItemEntry.calcAmount({ quantity: 2, rate: 1000, discount: 0 })).toBe(
      2000,
    );
  });

  it('applies a percentage discount', () => {
    expect(
      ItemEntry.calcAmount({
        quantity: 2,
        rate: 1000,
        discount: 10,
        discountType: DiscountType.Percentage,
      }),
    ).toBe(1800);
  });

  it('treats a missing discount type as percentage', () => {
    expect(
      ItemEntry.calcAmount({ quantity: 2, rate: 1000, discount: 10 }),
    ).toBe(1800);
  });

  it('applies an amount discount', () => {
    expect(
      ItemEntry.calcAmount({
        quantity: 2,
        rate: 1000,
        discount: 100,
        discountType: DiscountType.Amount,
      }),
    ).toBe(1900);
  });
});

const entry = (attrs: Partial<ItemEntry>) =>
  ItemEntry.fromJson({ quantity: 1, rate: 0, ...attrs } as any);

describe('ItemEntry line maths (cents, tax after discount)', () => {
  it('works out the plan example: 1.5 x 33.33, 2.5% discount, 15% exclusive', () => {
    const line = entry({
      quantity: 1.5,
      rate: 33.33,
      discount: 2.5,
      discountType: DiscountType.Percentage,
      taxRate: 15,
    });
    expect(line.amount).toBe(50);
    expect(line.discountAmount).toBe(1.25);
    expect(line.taxAmount).toBe(7.31);
    expect(line.totalExcludingTax).toBe(48.75);
    expect(line.total).toBe(56.06);
    expect(ItemEntry.calcAmount(line)).toBe(48.75);
  });

  it('taxes the amount after the discount: 33.33 less 10% at 15%', () => {
    const line = entry({ rate: 33.33, discount: 10, taxRate: 15 });
    expect(line.discountAmount).toBe(3.33);
    expect(line.taxAmount).toBe(4.5);
    expect(line.total).toBe(34.5);
  });

  it('splits an inclusive tax out of the discounted amount', () => {
    const line = entry({
      rate: 1150,
      discount: 150,
      discountType: DiscountType.Amount,
      taxRate: 15,
      isInclusiveTax: 1,
    });
    // 1,000 incl. 15% -> tax 130.43, net 869.57
    expect(line.taxAmount).toBe(130.43);
    expect(line.totalExcludingTax).toBe(869.57);
    expect(line.total).toBe(1000);
  });

  it('keeps a missing discount type as a percentage', () => {
    expect(entry({ rate: 200, discount: 2.5 }).discountAmount).toBe(5);
  });
});
