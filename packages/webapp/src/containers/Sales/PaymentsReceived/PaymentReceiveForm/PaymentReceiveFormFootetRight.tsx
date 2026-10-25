import React from 'react';
import styled from 'styled-components';
import {
  usePaymentReceiveTotals,
  usePaymentReceivedTotalExceededAmount,
  usePaymentReceivedOverAppliedAmount,
} from './utils';
import {
  T,
  TotalLines,
  TotalLine,
  TotalLineBorderStyle,
  TotalLineTextStyle,
  FormatNumber,
} from '@/components';

export function PaymentReceiveFormFootetRight() {
  const { formattedSubtotal, formattedTotal } = usePaymentReceiveTotals();
  const exceededAmount = usePaymentReceivedTotalExceededAmount();
  const overAppliedAmount = usePaymentReceivedOverAppliedAmount();

  return (
    <PaymentReceiveTotalLines labelColWidth={'180px'} amountColWidth={'180px'}>
      <TotalLine
        title={<T id={'payment_receive_form.label.subtotal'} />}
        value={formattedSubtotal}
        borderStyle={TotalLineBorderStyle.None}
      />
      <TotalLine
        title={<T id={'payment_receive_form.label.total'} />}
        value={formattedTotal}
        textStyle={TotalLineTextStyle.Bold}
      />
      <TotalLine
        title={'Exceeded Amount'}
        value={<FormatNumber value={exceededAmount} noZero={false} />}
        textStyle={TotalLineTextStyle.Regular}
      />
      {overAppliedAmount > 0 && (
        <TotalLine
          title={'Applied over amount received'}
          value={
            <OverAppliedValue>
              <FormatNumber value={overAppliedAmount} noZero={false} />
            </OverAppliedValue>
          }
          textStyle={TotalLineTextStyle.Regular}
        />
      )}
    </PaymentReceiveTotalLines>
  );
}

const PaymentReceiveTotalLines = styled(TotalLines)`
  --x-color-text: #555;

  .bp4-dark & {
    --x-color-text: var(--color-light-gray4);
  }
  width: 100%;
  color: var(--x-color-text);
`;

const OverAppliedValue = styled.span`
  color: var(--color-danger, #c23030);
  font-weight: 600;
`;
