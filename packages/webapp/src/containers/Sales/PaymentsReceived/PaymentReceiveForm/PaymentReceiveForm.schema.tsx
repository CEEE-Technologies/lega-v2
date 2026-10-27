import intl from 'react-intl-universal';
import * as Yup from 'yup';
import { moneyAtMostSibling } from '@/utils/yup-money';
import { DATATYPES_LENGTH } from '@/constants/dataTypes';

const Schema = Yup.object().shape({
  customerId: Yup.string().label(intl.get('customer_name_')).required(),
  paymentDate: Yup.date().required().label(intl.get('payment_date_')),
  depositAccountId: Yup.number().required().label(intl.get('deposit_account_')),
  amount: Yup.number().required().label('Amount'),
  paymentReceiveNo: Yup.string()
    .nullable()
    .max(DATATYPES_LENGTH.STRING)
    .label(intl.get('payment_received_no_')),
  referenceNo: Yup.string().min(1).max(DATATYPES_LENGTH.STRING).nullable(),
  // statement: Yup.string().nullable().max(DATATYPES_LENGTH.TEXT),
  branchId: Yup.string(),
  exchangeRate: Yup.number(),
  entries: Yup.array().of(
    Yup.object().shape({
      id: Yup.number().nullable(),
      dueAmount: Yup.number().nullable(),
      paymentAmount: moneyAtMostSibling('dueAmount'),
      entryType: Yup.string().nullable(),
      // The opening balance line has no invoice.
      invoiceId: Yup.number()
        .nullable()
        .when(['paymentAmount', 'entryType'], {
          is: (paymentAmount: unknown, entryType: unknown) =>
            !!paymentAmount && entryType !== 'opening_balance',
          then: Yup.number().required(),
        }),
    }),
  ),
});

export const CreatePaymentReceiveFormSchema = Schema;
export const EditPaymentReceiveFormSchema = Schema;
