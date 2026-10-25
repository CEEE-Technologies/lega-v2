import { useCurrentOrganizationMetadata } from '@/hooks/query';

export function CurrentCompany() {
  const metadata = useCurrentOrganizationMetadata();
  return (
    <span
      className="dashboard-current-company"
      title={metadata?.name}
      data-testId="current-company"
    >
      {metadata?.name}
    </span>
  );
}
