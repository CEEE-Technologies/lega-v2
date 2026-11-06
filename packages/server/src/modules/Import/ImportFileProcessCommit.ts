import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  IImportFileCommitedEventPayload,
  ImportFilePreviewPOJO,
} from './interfaces';
import { ImportFileProcess } from './ImportFileProcess';
import { ImportAls } from './ImportALS';
import { Injectable } from '@nestjs/common';
import { events } from '@/common/events/events';

@Injectable()
export class ImportFileProcessCommit {
  constructor(
    private readonly importFile: ImportFileProcess,
    private readonly importAls: ImportAls,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Commits the imported file under ALS.
   * @param {string} importId - The import ID.
   * @returns {Promise<ImportFilePreviewPOJO>}
   */
  public commit(importId: string): Promise<ImportFilePreviewPOJO> {
    return this.importAls.runCommit<Promise<ImportFilePreviewPOJO>>(() =>
      this.commitAlsRun(importId),
    );
  }

  /**
   * Commits the imported file.
   * @param {number} importId - The import ID.
   * @returns {Promise<ImportFilePreviewPOJO>}
   */
  public async commitAlsRun(importId: string): Promise<ImportFilePreviewPOJO> {
    // The import opens its own transaction: it is committed when the import
    // succeeds and rolled back when it fails, so the connection is always
    // given back.
    const meta = await this.importFile.import(importId);

    // Triggers `onImportFileCommitted` event.
    await this.eventEmitter.emitAsync(events.import.onImportCommitted, {
      meta,
      importId,
    } as IImportFileCommitedEventPayload);

    return meta;
  }
}
