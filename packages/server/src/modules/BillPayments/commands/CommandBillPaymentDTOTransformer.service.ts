import { roundMoney, sumMoneyBy } from '@bigcapital/utils';
import { Injectable } from '@nestjs/common';
import * as R from 'ramda';
import { omit } from 'lodash';
import { formatDateFields } from '@/utils/format-date-fields';
import { assocItemEntriesDefaultIndex } from '@/utils/associate-item-entries-index';
import { BranchTransactionDTOTransformer } from '@/modules/Branches/integrations/BranchTransactionDTOTransform';
import { Vendor } from '@/modules/Vendors/models/Vendor';
import { BillPayment } from '../models/BillPayment';
import { normalizePaymentEntryType } from '@/modules/Contacts/ContactOpeningBalance.constants';
import {
  CreateBillPaymentDto,
  EditBillPaymentDto,
} from '../dtos/BillPayment.dto';

@Injectable()
export class CommandBillPaymentDTOTransformer {
  constructor(
    private readonly branchDTOTransform: BranchTransactionDTOTransformer,
  ) {}

  /**
   * Transforms create/edit DTO to model.
   * @param {number} tenantId
   * @param {IBillPaymentDTO} billPaymentDTO - Bill payment.
   * @param {IBillPayment} oldBillPayment - Old bill payment.
   * @return {Promise<IBillPayment>}
   */
  public async transformDTOToModel(
    billPaymentDTO: CreateBillPaymentDto | EditBillPaymentDto,
    vendor: Vendor,
    _oldBillPayment?: BillPayment,
  ): Promise<BillPayment> {
    // Payment amounts are saved in whole cents.
    const amount = roundMoney(
      billPaymentDTO.amount ??
        sumMoneyBy(billPaymentDTO.entries, 'paymentAmount'),
    );

    // Associate the default index to each item entry.
    const entries = R.compose(
      // Associate the default index to payment entries.
      assocItemEntriesDefaultIndex,
    )(
      (billPaymentDTO.entries || []).map((entry) =>
        normalizePaymentEntryType(
          { ...entry, paymentAmount: roundMoney(entry.paymentAmount) },
          'billId',
        ),
      ),
    );

    const initialDTO = {
      ...formatDateFields(omit(billPaymentDTO, ['attachments']), [
        'paymentDate',
      ]),
      amount,
      currencyCode: vendor.currencyCode,
      exchangeRate: billPaymentDTO.exchangeRate || 1,
      entries,
    };
    return R.compose(this.branchDTOTransform.transformDTO<BillPayment>)(
      initialDTO,
    );
  }
}
