import classNames from 'classnames';
import type { CSSProperties } from 'react';
import './BrandLogo.scss';

interface BrandLogoProps {
  className?: string;
  width?: number;
  symbol?: boolean;
  tone?: 'auto' | 'white';
}

/** Uses the original LEGA asset as a mask, including its symbol-only crop. */
export function BrandLogo({
  className,
  width = 160,
  symbol = false,
  tone = 'auto',
}: BrandLogoProps) {
  return (
    <span
      role="img"
      aria-label="LEGA"
      className={classNames('lega-logo', className, {
        'lega-logo--symbol': symbol,
        'lega-logo--white': tone === 'white',
      })}
      style={{ '--lega-logo-width': `${width}px` } as CSSProperties}
    />
  );
}
