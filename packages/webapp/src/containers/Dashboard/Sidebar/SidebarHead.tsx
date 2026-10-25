import { Link } from 'react-router-dom';
import { BrandLogo } from '@/components/Brand/BrandLogo';

export function SidebarHead() {
  return (
    <div className="sidebar__head">
      <Link to="/" aria-label="LEGA home" className="sidebar__brand-full">
        <BrandLogo width={144} tone="white" />
      </Link>
      <Link to="/" aria-label="LEGA home" className="sidebar__brand-symbol">
        <BrandLogo width={26} symbol tone="white" />
      </Link>
    </div>
  );
}
