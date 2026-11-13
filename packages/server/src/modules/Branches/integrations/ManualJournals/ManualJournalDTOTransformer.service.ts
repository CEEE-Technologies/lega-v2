import { Inject, Injectable } from '@nestjs/common';
import { omit } from 'lodash';
import { BranchesSettingsService } from '../../BranchesSettings';
import { IManualJournalDTO } from '@/modules/ManualJournals/types/ManualJournals.types';

@Injectable()
export class ManualJournalBranchesDTOTransformer {
  constructor(
    @Inject()
    private readonly branchesSettings: BranchesSettingsService,
  ) {}

  /**
   *
   * @param DTO
   * @returns
   */
  private excludeDTOBranchIdWhenInactive = async (
    DTO: IManualJournalDTO,
  ): Promise<IManualJournalDTO> => {
    const isActive = await this.branchesSettings.isMultiBranchesActive();

    if (isActive) {
      // A line without its own branch takes the journal's: the branch
      // check passes on the journal's branch, and the ledger is written
      // per line, so those lines were posted with no branch at all.
      const branchId = (DTO as IManualJournalDTO & { branchId?: number })
        .branchId;
      return {
        ...DTO,
        entries: DTO.entries.map((e) =>
          e.branchId || !branchId ? e : { ...e, branchId },
        ),
      };
    }
    return {
      ...DTO,
      entries: DTO.entries.map((e) => omit(e, ['branchId'])),
    };
  };

  /**
   *
   */
  public transformDTO = async (
    DTO: IManualJournalDTO,
  ): Promise<IManualJournalDTO> => {
    return this.excludeDTOBranchIdWhenInactive(DTO);
  };
}
