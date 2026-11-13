import { GetRecognizedTransactionTransformer } from './GetRecognizedTransactionTransformer';

/**
 * The recognized-line fields read the line's recognition, its account and
 * its rule. A line without them used to throw (a 500); they are now empty.
 */
describe('GetRecognizedTransactionTransformer', () => {
  const transformer = new GetRecognizedTransactionTransformer();
  const fields = [
    'assignedAccountId',
    'assignedAccountName',
    'assignedAccountCode',
    'assignedPayee',
    'assignedMemo',
    'assignedCategory',
    'bankRuleId',
    'bankRuleName',
  ];

  it('a line with no recognition gives empty fields instead of throwing', () => {
    for (const field of fields) {
      expect(() => (transformer as any)[field]({})).not.toThrow();
      expect((transformer as any)[field]({})).toBeUndefined();
    }
  });

  it('a recognition without its account or rule loaded gives empty names', () => {
    const line = {
      recognizedTransaction: { assignedAccountId: 5, bankRuleId: 2 },
    };
    expect((transformer as any).assignedAccountId(line)).toBe(5);
    expect((transformer as any).assignedAccountName(line)).toBeUndefined();
    expect((transformer as any).bankRuleName(line)).toBeUndefined();
  });

  it('outputs the assigned payee (its method name matches the attribute)', () => {
    expect(transformer.includeAttributes()).toContain('assignedPayee');
    expect(
      (transformer as any).assignedPayee({
        recognizedTransaction: { assignedPayee: 'Acme' },
      }),
    ).toBe('Acme');
  });
});
