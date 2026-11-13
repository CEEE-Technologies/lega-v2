// @ts-nocheck
import {
  Button,
  Popover,
  PopoverInteractionKind,
  FormGroup,
  Position,
  Classes,
  Intent,
} from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import React from 'react';
import intl from 'react-intl-universal';
import styled from 'styled-components';
import { ExchangeRateInputGroup, Icon } from '@/components';

interface ExchangeRateMutedFieldProps {
  name?: string;
  toCurrency?: React.ReactNode;
  fromCurrency?: React.ReactNode;
  date?: React.ReactNode;
  exchangeRate?: React.ReactNode;
  exchangeRateFieldProps?: Record<string, unknown>;
  popoverProps?: Record<string, unknown>;
  formGroupProps?: Record<string, unknown>;
}

export function ExchangeRateMutedField({
  name,
  toCurrency,
  fromCurrency,
  date,
  exchangeRate,
  exchangeRateFieldProps,
  popoverProps,
  ...formGroupProps
}: ExchangeRateMutedFieldProps) {
  const { getFieldMeta } = useFormikContext();
  const meta = name ? getFieldMeta(name) : null;
  // An empty rate (no rate found for a foreign currency) or a refused one
  // is shown, not hidden behind the pencil.
  const isEmpty = exchangeRate === '' || exchangeRate == null;
  const error = meta?.touched || meta?.error ? meta?.error : null;

  const content = (
    <ExchangeRateFormGroupContent>
      <ExchangeRateInputGroup
        name={name}
        fromCurrency={fromCurrency}
        toCurrency={toCurrency}
        {...exchangeRateFieldProps}
      />
    </ExchangeRateFormGroupContent>
  );

  return (
    <ExchangeRateFormGroup
      label={`As on ${date},`}
      {...formGroupProps}
      intent={error ? Intent.DANGER : undefined}
      helperText={error || undefined}
    >
      <Popover
        content={content}
        interactionKind={PopoverInteractionKind.CLICK}
        position={Position.RIGHT_TOP}
        modifiers={{
          offset: { offset: '0, 4' },
        }}
        {...popoverProps}
        minimal={true}
        usePortal={false}
        target={<div />}
      >
        <ExchangeRateButton data-empty={isEmpty || undefined}>
          {isEmpty
            ? `${intl.get('exchange_rate.enter_rate')}: 1 ${fromCurrency} = ? ${toCurrency}`
            : `1 ${fromCurrency} = ${exchangeRate} ${toCurrency}`}
          <Button
            className={Classes.MINIMAL}
            rightIcon={<Icon icon="pen-18" iconSize={14} />}
            small={true}
          />
        </ExchangeRateButton>
      </Popover>
    </ExchangeRateFormGroup>
  );
}

const ExchangeRateFormGroup = styled(FormGroup)`
  &.bp4-form-group {
    label.bp4-label {
      font-size: 12px;
      opacity: 0.7;
      line-height: 1;
      margin-bottom: 5px;
    }
  }
`;

const ExchangeRateButton = styled.div`
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 400;
  color: #0d244a;
  position: relative;
  padding-right: 28px;

  .bp4-dark & {
    color: var(--color-light-gray1);
  }

  &[data-empty] {
    color: var(--color-danger, #c23030);
  }

  .bp4-button {
    position: absolute;
    right: 0;
  }
`;

const ExchangeRateFormGroupContent = styled.div`
  padding: 5px 0;

  .bp4-form-group {
    padding: 2px;
    margin: 2px 4px !important;
  }
`;
