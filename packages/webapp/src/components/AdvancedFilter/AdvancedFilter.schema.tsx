import * as Yup from 'yup';

export const getFilterDropdownSchema = () =>
  Yup.object().shape({
    conditions: Yup.array().of(
      Yup.object().shape({
        fieldKey: Yup.string(),
        // Text, a date, an option key or a boolean (checkbox fields).
        value: Yup.mixed().nullable(),
        condition: Yup.string().nullable(),
        comparator: Yup.string().nullable(),
      }),
    ),
  });
