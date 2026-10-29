// @ts-nocheck
import { roundMoney } from '@bigcapital/utils';
import { FormGroup, Intent } from '@blueprintjs/core';
import React, { useCallback, useState, useEffect } from 'react';
import { MoneyInputGroup } from '@/components';
import { CellType } from '@/constants';

const PercentFieldCell = ({
  cell: { value: initialValue },
  row: { index, original },
  column: { id },
  payload: { errors, updateData },
}) => {
  const [value, setValue] = useState(initialValue);

  // A line discount is a percentage unless the line says it is a fixed
  // amount; either way it keeps up to 2 decimals (2.5% stays 2.5%).
  const isAmount = original?.discountType === 'amount';

  const handleBlurChange = (newValue) => {
    const parsedValue =
      newValue === '' || newValue === undefined || newValue === null
        ? ''
        : roundMoney(newValue);
    updateData(index, id, parsedValue);
  };

  const handleChange = useCallback(
    (value) => {
      setValue(value);
    },
    [setValue],
  );

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const error = errors?.[index]?.[id];

  return (
    <FormGroup intent={error ? Intent.DANGER : null}>
      <MoneyInputGroup
        prefix={isAmount ? '' : '%'}
        value={value}
        onChange={handleChange}
        onBlurValue={handleBlurChange}
      />
    </FormGroup>
  );
};

PercentFieldCell.cellType = CellType.Field;

export default PercentFieldCell;
