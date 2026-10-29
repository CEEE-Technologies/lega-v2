// Fails the test file when the strict ledger mode recorded an unbalanced
// entry set, even if an event handler swallowed the error.
afterAll(() => {
  const store = globalThis as { __ledgerStrictViolations?: string[] };
  const violations = store.__ledgerStrictViolations || [];
  store.__ledgerStrictViolations = [];

  if (violations.length > 0) {
    throw new Error(
      `Strict ledger mode: unbalanced entry sets were written:\n${violations.join('\n')}`,
    );
  }
});
