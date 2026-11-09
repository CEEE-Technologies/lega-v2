import { Classes, Intent, Tag } from '@blueprintjs/core';
import { css } from '@emotion/css';
import { x } from '@xstyled/emotion';
import React from 'react';
import { FormattedMessage as T } from '@/components';

export interface NonDeletableReason {
  id: number;
  type: string;
  message: string;
}

/** The reasons shown: the distinct messages, at most this many. */
const MAX_REASONS = 3;

interface BulkDeleteDialogContentProps {
  /** Why the ones that can't be deleted are refused (from the server). */
  nonDeletableReasons?: NonDeletableReason[];
  totalSelected: number;
  deletableCount: number;
  undeletableCount: number;
  resourceSingularLabel: string;
  resourcePluralLabel: string;
}

export function BulkDeleteDialogContent({
  totalSelected,
  deletableCount,
  undeletableCount,
  resourceSingularLabel,
  resourcePluralLabel,
  nonDeletableReasons = [],
}: BulkDeleteDialogContentProps) {
  // One line per distinct reason, with how many it applies to.
  const reasons = Object.entries(
    nonDeletableReasons.reduce<Record<string, number>>((acc, reason) => {
      acc[reason.message] = (acc[reason.message] ?? 0) + 1;
      return acc;
    }, {}),
  );
  return (
    <div className={Classes.DIALOG_BODY}>
      <x.p fontWeight="semibold">
        <T
          id={'bulk_delete_selected_summary'}
          values={{ count: totalSelected, resourcePlural: resourcePluralLabel }}
        />
      </x.p>

      <x.div display="flex" alignItems="center" gap={'12px'}>
        <Tag intent={Intent.DANGER} minimal>
          {deletableCount}
        </Tag>
        <x.div>
          <T
            id={'bulk_delete_will_be_deleted'}
            values={{ resourceSingular: resourceSingularLabel }}
          />{' '}
        </x.div>
      </x.div>

      <x.div display="flex" alignItems="center" gap={'12px'} mt={'8px'}>
        {/* `Intent.INFO` was removed in Blueprint v5; using PRIMARY as the
            nearest equivalent for the "cannot be deleted" tag. */}
        <Tag intent={Intent.PRIMARY} minimal>
          {undeletableCount}
        </Tag>
        <x.div>
          <T
            id={'bulk_delete_cannot_be_deleted'}
            values={{ resourceSingular: resourceSingularLabel }}
          />{' '}
        </x.div>
      </x.div>

      {reasons.length > 0 && (
        <x.ul mt={'8px'} pl={'20px'} data-testid="bulk-delete-reasons">
          {reasons.slice(0, MAX_REASONS).map(([message, count]) => (
            <li key={message}>
              {count > 1 ? `${count} × ` : ''}
              {message}
            </li>
          ))}
          {reasons.length > MAX_REASONS && <li>…</li>}
        </x.ul>
      )}

      <x.p mt={'12px'}>
        <T
          id={'bulk_delete_selected_description'}
          values={{ resourcePlural: resourcePluralLabel }}
        />
      </x.p>

      <x.div pt={'12px'} mt={'16px'} className={noteDividerClassName}>
        <x.span fontWeight="bold">
          <T id={'note'} />
          {':'}
        </x.span>
        <x.p>
          <T
            id={'bulk_delete_note_description'}
            values={{ resourcePlural: resourcePluralLabel }}
          />
        </x.p>
      </x.div>
    </div>
  );
}

const noteDividerClassName = css`
  border-top: 1px solid rgba(17, 20, 24, 0.15);

  .bp4-dark & {
    border-top-color: rgba(255, 255, 255, 0.2);
  }
`;
