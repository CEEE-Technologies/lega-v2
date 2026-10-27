import { formatNumber } from './format-number';

describe('formatNumber (PDFs, emails, reports)', () => {
  it('rounds halves away from zero before formatting', () => {
    expect(formatNumber(1.005, { money: false })).toBe('1.01');
    expect(formatNumber(-1.005, { money: false })).toBe('-1.01');
    expect(formatNumber(0.125, { money: false })).toBe('0.13');
    expect(formatNumber(1234567.895, { money: false })).toBe('1,234,567.90');
  });

  it('shows a value with float error as its cents', () => {
    expect(formatNumber(1.1 + 2.2, { money: false })).toBe('3.30');
  });

  it('keeps the given precision', () => {
    expect(formatNumber(12.3456, { money: false, precision: 0 })).toBe('12');
    expect(formatNumber(2.5, { money: false, precision: 0 })).toBe('3');
  });
});
