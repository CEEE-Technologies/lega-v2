import React from 'react';
import LegaLoading from './LegaLoading';
import { Choose } from '@/components';

interface DashboardLoadingIndicatorProps {
  isLoading?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Dashboard loading indicator.
 */
export default function DashboardLoadingIndicator({
  isLoading = false,
  className,
  children,
}: DashboardLoadingIndicatorProps) {
  return (
    <Choose>
      <Choose.When condition={isLoading}>
        <LegaLoading />
      </Choose.When>

      <Choose.Otherwise>{children}</Choose.Otherwise>
    </Choose>
  );
}
