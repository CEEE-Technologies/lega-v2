import classNames from 'classnames';
import { BrandLogo } from '@/components/Brand/BrandLogo';
import '@/style/components/LegaLoading.scss';

export default function LegaLoading({ className }: { className?: string }) {
  return (
    <div
      className={classNames('lega-loading', className)}
      role="status"
      aria-label="Loading LEGA"
    >
      <div className="center">
        <BrandLogo width={184} />
        <div className="lega-loading__progress" aria-hidden="true" />
      </div>
    </div>
  );
}
