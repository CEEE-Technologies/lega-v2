// The tenant migration exports its helpers for this test.
const migration = require('./migrations/20261103120100_unique_document_numbers');
const fitTo = (head: string, tail: string, max: number): string =>
  migration.fitNumber(head, tail, max);

describe('unique_document_numbers: new numbers fit the column', () => {
  it('adds the suffix when there is room', () => {
    expect(fitTo('EST-00013', '-2', 255)).toBe('EST-00013-2');
    expect(fitTo('CN-', '00064', 255)).toBe('CN-00064');
  });

  it('cuts a 255-character number so number + suffix is 255 characters', () => {
    const long = 'J'.repeat(255);
    const fitted = fitTo(long, '-2', 255);
    expect(fitted).toHaveLength(255);
    expect(fitted).toBe(`${'J'.repeat(253)}-2`);
    expect(fitTo(long, '-10', 255)).toBe(`${'J'.repeat(252)}-10`);
  });

  it('fits the shortest column the number is copied to', () => {
    expect(fitTo('A'.repeat(200), '-3', 100)).toBe(`${'A'.repeat(98)}-3`);
  });

  it('cuts the prefix, not the number, for prefixed numbers', () => {
    expect(fitTo('P'.repeat(300), '1234', 10)).toBe('PPPPPP1234');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(fitTo('é'.repeat(10), '-2', 6)).toBe('éééé-2');
  });

  it('drops trailing spaces where the cut lands', () => {
    expect(fitTo('AB  CD', '-2', 6)).toBe('AB-2');
  });
});
