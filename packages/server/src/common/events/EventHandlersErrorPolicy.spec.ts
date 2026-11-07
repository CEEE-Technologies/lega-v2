import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Lists every `@OnEvent` handler in the server and checks its error policy.
 *
 * Since the event-emitter patch, a handler error stops the save (the
 * transaction rolls back) unless the handler says `{ suppressErrors: true }`.
 * That opt-out is only for side effects: mail, SMS, analytics, audit log,
 * live-update notices, Plaid, queued jobs, and work that runs after the save
 * has committed.
 *
 * A handler that receives the database transaction (`trx`) usually writes or
 * checks data as part of the save, so ignoring its errors would let a save
 * finish half-done. Such a handler may only ignore errors if its file is on
 * the short reviewed list below.
 */

/** Files whose handlers receive `trx` but may still ignore errors. */
const REVIEWED_SIDE_EFFECTS_WITH_TRX: Record<string, string> = {
  'modules/EE/AuditLogs/subscribers/FinancialAuditLog.subscriber.ts':
    'audit log row; a failed audit write must not undo the save',
  'modules/AuditLogs/subscribers/FinancialAuditLog.subscriber.ts':
    'old copy of the audit log subscriber (module not loaded)',
  'modules/PaymentReceived/subscribers/PaymentReceivedSmsNotificationSubscriber.ts':
    'SMS sent after commit; trx is only used to wait for the commit',
  'modules/SaleEstimates/subscribers/SaleEstimateSmsNotificationSubscriber.ts':
    'SMS sent after commit; trx is only used to wait for the commit',
  'modules/SaleInvoices/subscribers/SaleInvoiceSmsNotificationSubscriber.ts':
    'SMS sent after commit; trx is only used to wait for the commit',
  'modules/SaleReceipts/subscribers/SaleReceiptSmsNotificationSubscriber.ts':
    'SMS sent after commit; trx is only used to wait for the commit',
  'modules/BankingTranasctionsRegonize/events/TriggerRecognizedTransactions.ts':
    'bank-rules job queued after commit; trx is only used to wait for the commit',
};

interface HandlerInfo {
  file: string;
  line: number;
  method: string;
  events: string[];
  suppress: 'true' | 'false' | 'default' | 'mixed';
  receivesTrx: boolean;
  hasSideEffectComment: boolean;
}

const SRC_DIR = path.resolve(__dirname, '../..');

const listSourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
};

const suppressOptionOf = (call: ts.CallExpression): 'true' | 'false' | null => {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const prop of options.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      prop.name.getText() === 'suppressErrors'
    ) {
      const value = prop.initializer.getText();
      if (value === 'true' || value === 'false') return value;
      throw new Error(`suppressErrors must be a literal, got ${value}`);
    }
  }
  return null;
};

const collectHandlers = (): HandlerInfo[] => {
  const handlers: HandlerInfo[] = [];

  for (const file of listSourceFiles(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('@OnEvent(')) continue;

    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node)) {
        const decorators = (ts.getDecorators(node) || []).filter(
          (d) =>
            ts.isCallExpression(d.expression) &&
            d.expression.expression.getText() === 'OnEvent',
        );
        if (decorators.length > 0) {
          const options = decorators.map((d) =>
            suppressOptionOf(d.expression as ts.CallExpression),
          );
          const values = new Set(options.map((o) => o ?? 'default'));
          const suppress =
            values.size > 1
              ? 'mixed'
              : (values.values().next().value as HandlerInfo['suppress']);

          const param = node.parameters[0]?.name.getText() ?? '';
          const body = node.body?.getText() ?? '';
          const receivesTrx = /\btrx\b/.test(param) || /\btrx\b/.test(body);

          const first = decorators[0];
          const comments =
            ts.getLeadingCommentRanges(text, first.getFullStart()) || [];
          const hasSideEffectComment = comments.some((c) =>
            /Side effect/.test(text.slice(c.pos, c.end)),
          );
          handlers.push({
            file: path.relative(SRC_DIR, file).split(path.sep).join('/'),
            line: sf.getLineAndCharacterOfPosition(first.getStart()).line + 1,
            method: node.name.getText(),
            events: decorators.map((d) =>
              (d.expression as ts.CallExpression).arguments[0].getText(),
            ),
            suppress,
            receivesTrx,
            hasSideEffectComment,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return handlers;
};

const label = (h: HandlerInfo) => `${h.file}:${h.line} ${h.method}`;

describe('event handler error policy', () => {
  const handlers = collectHandlers();

  it('finds the handlers (scanner sanity check)', () => {
    // There are about 640 handlers; a much lower number means the scan broke.
    expect(handlers.length).toBeGreaterThan(600);
  });

  it('never mixes error options on one handler', () => {
    expect(handlers.filter((h) => h.suppress === 'mixed').map(label)).toEqual(
      [],
    );
  });

  it('only lets a handler that receives trx ignore errors if it is on the reviewed list', () => {
    const offenders = handlers
      .filter((h) => h.suppress === 'true' && h.receivesTrx)
      .filter((h) => !(h.file in REVIEWED_SIDE_EFFECTS_WITH_TRX))
      .map(label);
    expect(offenders).toEqual([]);
  });

  it('explains every handler that ignores errors with a "Side effect" comment', () => {
    const missing = handlers
      .filter((h) => h.suppress === 'true' && !h.hasSideEffectComment)
      .map(label);
    expect(missing).toEqual([]);
  });

  it('keeps the reviewed list free of files that no longer need it', () => {
    const stale = Object.keys(REVIEWED_SIDE_EFFECTS_WITH_TRX).filter(
      (file) =>
        !handlers.some(
          (h) => h.file === file && h.suppress === 'true' && h.receivesTrx,
        ),
    );
    expect(stale).toEqual([]);
  });
});
