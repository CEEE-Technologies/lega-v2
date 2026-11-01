import { CreditNoteGLEntriesSubscriber } from './CreditNoteGLEntriesSubscriber';
import { CreditNoteGLEntries } from '../commands/CreditNoteGLEntries';

/**
 * Editing a published credit note never rewrote its journal: the edit
 * handler read `isPublished` from the partial graph the edit saved, which
 * has no `openedAt`.
 */
describe('CreditNoteGLEntriesSubscriber', () => {
  const trx = { trx: true } as any;
  let glEntries: {
    rewriteCreditNoteGLEntries: jest.Mock;
    revertVendorCreditGLEntries: jest.Mock;
  };
  let subscriber: CreditNoteGLEntriesSubscriber;

  beforeEach(() => {
    glEntries = {
      rewriteCreditNoteGLEntries: jest.fn().mockResolvedValue(undefined),
      revertVendorCreditGLEntries: jest.fn().mockResolvedValue(undefined),
    };
    subscriber = new CreditNoteGLEntriesSubscriber(glEntries as any);
  });

  it('rewrites the journal on edit even when the saved graph has no openedAt', async () => {
    await subscriber.editVendorCreditGLEntriesOnceEdited({
      // The partial graph an edit of a published credit note saves.
      creditNote: { id: 6, isPublished: false },
      oldCreditNote: { id: 6, isPublished: true },
      trx,
    } as any);

    expect(glEntries.rewriteCreditNoteGLEntries).toHaveBeenCalledWith(6, trx);
  });

  it('reverts the journal of a deleted published credit note inside the delete transaction', async () => {
    await subscriber.revertGLEntriesOnceCreditNoteDeleted({
      creditNoteId: 6,
      oldCreditNote: { id: 6, isPublished: true },
      trx,
    } as any);

    expect(glEntries.revertVendorCreditGLEntries).toHaveBeenCalledWith(6, trx);
  });

  it('leaves the ledger alone when a draft is deleted', async () => {
    await subscriber.revertGLEntriesOnceCreditNoteDeleted({
      creditNoteId: 6,
      oldCreditNote: { id: 6, isPublished: false },
      trx,
    } as any);

    expect(glEntries.revertVendorCreditGLEntries).not.toHaveBeenCalled();
  });
});

describe('CreditNoteGLEntries.rewriteCreditNoteGLEntries', () => {
  const trx = { trx: true } as any;

  const setup = (stored: any) => {
    const findById = jest.fn().mockResolvedValue(stored);
    const query = jest.fn().mockReturnValue({ findById });
    const glEntries = new CreditNoteGLEntries(
      {} as any,
      {} as any,
      (() => ({ query })) as any,
    );
    const revert = jest
      .spyOn(glEntries, 'revertVendorCreditGLEntries')
      .mockResolvedValue(undefined);
    const edit = jest
      .spyOn(glEntries, 'editVendorCreditGLEntries')
      .mockResolvedValue(undefined);
    return { glEntries, query, findById, revert, edit };
  };

  it('rewrites the journal of a stored published credit note', async () => {
    const { glEntries, query, findById, revert, edit } = setup({
      id: 6,
      isPublished: true,
    });

    await glEntries.rewriteCreditNoteGLEntries(6, trx);

    expect(query).toHaveBeenCalledWith(trx);
    expect(findById).toHaveBeenCalledWith(6);
    expect(edit).toHaveBeenCalledWith(6, trx);
    expect(revert).not.toHaveBeenCalled();
  });

  it('writes no journal for a stored draft (and clears any left)', async () => {
    const { glEntries, revert, edit } = setup({ id: 6, isPublished: false });

    await glEntries.rewriteCreditNoteGLEntries(6, trx);

    expect(edit).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledWith(6, trx);
  });
});
