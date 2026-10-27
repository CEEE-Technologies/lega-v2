// Jest runs test files inside a V8 VM context whose `Error` realm differs from
// the host process. Third-party libraries (e.g. eventemitter2's
// MaxListenersExceededWarning) call `process.emitWarning(err)` with a VM-realm
// Error instance, which Node's host-side validation rejects and crashes e2e
// app boot. Patch it so non-string warnings are always forwarded as a string.
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, options?: any) => {
  if (typeof warning === 'string') {
    return originalEmitWarning(warning, options);
  }
  return originalEmitWarning(
    warning?.message ?? String(warning),
    options ?? { type: warning?.name },
  );
}) as typeof process.emitWarning;

// Strict ledger mode: an entry set that doesn't balance to the cent throws
// (and is recorded, see setup-after-env.ts) instead of only logging.
process.env.LEDGER_STRICT_MODE = process.env.LEDGER_STRICT_MODE ?? 'true';
