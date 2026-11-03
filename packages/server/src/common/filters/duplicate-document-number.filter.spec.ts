import { UniqueViolationError } from 'objection';
import { DuplicateDocumentNumberFilter } from './duplicate-document-number.filter';
import { getDocumentNumberIndexLabel } from '../constants/document-numbers';

const host = () => {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return {
    res,
    host: { switchToHttp: () => ({ getResponse: () => res }) } as any,
  };
};

const violation = (constraint: string) =>
  new UniqueViolationError({
    nativeError: new Error(`Duplicate entry 'X' for key '${constraint}'`),
    client: 'mysql',
    table: undefined,
    columns: undefined,
    constraint,
  } as any);

describe('DuplicateDocumentNumberFilter', () => {
  it('reads the document from the index name', () => {
    expect(getDocumentNumberIndexLabel('CREDIT_NOTES_DOC_NUMBER_UNIQUE')).toBe(
      'Credit note',
    );
    expect(getDocumentNumberIndexLabel('API_KEYS_KEY_HASH_UNIQUE')).toBe('');
    expect(getDocumentNumberIndexLabel(undefined)).toBe('');
  });

  it('answers a duplicate document number with 409', () => {
    const { res, host: h } = host();
    new DuplicateDocumentNumberFilter().catch(
      violation('CREDIT_NOTES_DOC_NUMBER_UNIQUE'),
      h,
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].errors[0].type).toBe(
      'DOCUMENT_NUMBER_EXISTS',
    );
  });

  it('keeps 500 for other unique indexes', () => {
    const { res, host: h } = host();
    const filter = new DuplicateDocumentNumberFilter();
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    filter.catch(violation('USERS_EMAIL_UNIQUE'), h);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
