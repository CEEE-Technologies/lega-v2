import intl from 'react-intl-universal';
import { brandLinks } from './branding';

export const getFooterLinks = (): Array<{ title: string; link: string }> =>
  [
    { title: intl.get('support'), link: brandLinks.support },
    { title: intl.get('docs'), link: brandLinks.docs },
    { title: 'LEGA', link: brandLinks.website },
  ].filter((item): item is { title: string; link: string } =>
    Boolean(item.link),
  );
