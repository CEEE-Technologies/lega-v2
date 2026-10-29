import { roundMoney, sumMoneyBy } from '@bigcapital/utils';
import * as R from 'ramda';
import { Inject, Injectable } from '@nestjs/common';
import { omit } from 'lodash';
import * as composeAsync from 'async/compose';
import {
  IPaymentReceivedCreateDTO,
  IPaymentReceivedEditDTO,
} from '../types/PaymentReceived.types';
import { PaymentReceivedValidators } from './PaymentReceivedValidators.service';
import { PaymentReceivedIncrement } from './PaymentReceivedIncrement.service';
import { BranchTransactionDTOTransformer } from '@/modules/Branches/integrations/BranchTransactionDTOTransform';
import { BrandingTemplateDTOTransformer } from '@/modules/PdfTemplate/BrandingTemplateDTOTransformer';
import { PaymentReceived } from '../models/PaymentReceived';
import { assocItemEntriesDefaultIndex } from '@/utils/associate-item-entries-index';
import { Customer } from '@/modules/Customers/models/Customer';
import { formatDateFields } from '@/utils/format-date-fields';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { normalizePaymentEntryType } from '@/modules/Contacts/ContactOpeningBalance.constants';

@Injectable()
export class PaymentReceiveDTOTransformer {
  constructor(
    private readonly validators: PaymentReceivedValidators,
    private readonly increments: PaymentReceivedIncrement,
    private readonly branchDTOTransform: BranchTransactionDTOTransformer,
    private readonly brandingTemplatesTransformer: BrandingTemplateDTOTransformer,

    @Inject(PaymentReceived.name)
    private readonly paymentReceivedModel: TenantModelProxy<
      typeof PaymentReceived
    >,
  ) {}

  /**
   * Transformes the create payment receive DTO to model object.
   * @param {IPaymentReceivedCreateDTO|IPaymentReceivedEditDTO} paymentReceiveDTO - Payment receive DTO.
   * @param {IPaymentReceived} oldPaymentReceive -
   * @return {IPaymentReceived}
   */
  public async transformPaymentReceiveDTOToModel(
    customer: Customer,
    paymentReceiveDTO: IPaymentReceivedCreateDTO | IPaymentReceivedEditDTO,
    oldPaymentReceive?: PaymentReceived,
  ): Promise<PaymentReceived> {
    // Payment amounts are saved in whole cents.
    const amount = roundMoney(
      paymentReceiveDTO.amount ??
        sumMoneyBy(paymentReceiveDTO.entries, 'paymentAmount'),
    );

    this.validators.validateEntriesWithinAmount(
      amount,
      paymentReceiveDTO.entries,
    );

    // Retreive the next invoice number.
    const autoNextNumber = await this.increments.getNextPaymentReceiveNumber();

    // Retrieve the next payment receive number.
    const paymentReceiveNo =
      paymentReceiveDTO.paymentReceiveNo ||
      oldPaymentReceive?.paymentReceiveNo ||
      autoNextNumber;

    this.validators.validatePaymentNoRequire(paymentReceiveNo);

    const entries = R.compose(
      // Associate the default index to each item entry line.
      assocItemEntriesDefaultIndex,
    )(
      paymentReceiveDTO.entries.map((entry) =>
        normalizePaymentEntryType(
          { ...entry, paymentAmount: roundMoney(entry.paymentAmount) },
          'invoiceId',
        ),
      ),
    );

    const initialDTO = {
      ...formatDateFields(omit(paymentReceiveDTO, ['entries', 'attachments']), [
        'paymentDate',
      ]),
      amount,
      currencyCode: customer.currencyCode,
      ...(paymentReceiveNo ? { paymentReceiveNo } : {}),
      exchangeRate: paymentReceiveDTO.exchangeRate || 1,
      entries,
    };
    const asyncDto = await composeAsync(
      this.branchDTOTransform.transformDTO<PaymentReceived>,

      // Assigns the default branding template id to the invoice DTO.
      this.brandingTemplatesTransformer.assocDefaultBrandingTemplate(
        'SaleInvoice',
      ),
    )(initialDTO);

    return asyncDto;
  }
}
