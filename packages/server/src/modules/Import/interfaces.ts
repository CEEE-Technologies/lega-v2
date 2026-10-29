import { IModelMetaField2 } from '@/interfaces/Model';
import { ImportModelShape } from './models/Import';

export interface ImportMappingAttr {
  from: string;
  to: string;
  group?: string;
  dateFormat?: string;
}

export interface ImportValidationError {
  index: number;
  property: string;
  constraints: Record<string, string>;
}

export type ResourceMetaFieldsMap = { [key: string]: IModelMetaField2 };

export interface ImportInsertError {
  rowNumber: number;
  errorCode: string;
  errorMessage: string;
}

export interface ImportFileUploadPOJO {
  import: {
    importId: string;
    resource: string;
  };
  sheetColumns: string[];
  resourceColumns: {
    key: string;
    name: string;
    required?: boolean;
    hint?: string;
  }[];
}

export interface ImportFileMapPOJO {
  import: {
    importId: string;
    resource: string;
  };
}

/**
 * A money value of the imported file rounded to cents.
 */
export interface ImportRoundedMoneyWarning {
  rowNumber: number;
  field: string;
  value: number;
  roundedValue: number;
  message: string;
}

export interface ImportFilePreviewPOJO {
  resource: string;
  createdCount: number;
  skippedCount: number;
  totalCount: number;
  errorsCount: number;
  errors: ImportInsertError[];
  unmappedColumns: string[];
  unmappedColumnsCount: number;
  /** Money values rounded to cents (they had more than 2 decimals). */
  warnings?: ImportRoundedMoneyWarning[];
  warningsCount?: number;
}

export interface ImportOperSuccess {
  data: unknown;
  index: number;
}

export interface ImportOperError {
  error: ImportInsertError[];
  index: number;
}

export interface ImportableContext {
  import: ImportModelShape;
  rowIndex: number;
}

export const ImportDateFormats = [
  'yyyy-MM-dd',
  'dd.MM.yy',
  'MM/dd/yy',
  'dd/MMM/yyyy',
];

export interface IImportFileCommitedEventPayload {
  importId: string;
  meta: ImportFilePreviewPOJO;
}
