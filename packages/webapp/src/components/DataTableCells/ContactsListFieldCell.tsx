// @ts-nocheck
import { FormGroup, Intent, Classes } from '@blueprintjs/core';
import classNames from 'classnames';
import React, { useCallback } from 'react';
import { ContactsSuggestField } from '@/components';
import { CellType } from '@/constants';
export default function ContactsListCellRenderer({
  column: { id },
  row: { index, original },
  cell: { value },
  payload: { contacts, updateData, errors },
}) {
  const handleContactSelected = useCallback(
    (contact) => {
      // The column's own field (`contactId`): `contact_id` isn't a form
      // field, so the picked contact was dropped on save.
      updateData(index, id, contact.id);
    },
    [updateData, index, id],
  );

  const error = errors?.[index]?.[id];

  return (
    <FormGroup
      intent={error ? Intent.DANGER : null}
      className={classNames(
        'form-group--select-list',
        'form-group--contacts-list',
        Classes.FILL,
      )}
    >
      <ContactsSuggestField
        contactsList={contacts}
        onContactSelected={handleContactSelected}
        selectedContactId={original?.[id]}
        selectedContactType={original?.contact_type}
      />
    </FormGroup>
  );
}

ContactsListCellRenderer.cellType = CellType.Field;
