import { For, FormattedMessage as T } from '@/components';
import { BrandLogo } from '@/components/Brand/BrandLogo';
import { getFooterLinks } from '@/constants/footerLinks';
import { useAuthActions } from '@/hooks/state';

/**
 * Footer item link.
 */
function FooterLinkItem({ title, link }: { title: string; link: string }) {
  return (
    <div className="content__links-item">
      <a href={link} target="_blank" rel="noreferrer">
        {title}
      </a>
    </div>
  );
}

/**
 * Setup left section footer.
 */
function SetupLeftSectionFooter() {
  // Retrieve the footer links.
  const footerLinks = getFooterLinks();

  if (!footerLinks.length) return null;

  return (
    <div className={'content__footer'}>
      <div className={'content__links'}>
        <For render={FooterLinkItem} of={footerLinks} />
      </div>
    </div>
  );
}

/**
 * Setup left section header.
 */
function SetupLeftSectionHeader() {
  const { setLogout } = useAuthActions();

  // Handle logout link click.
  const onClickLogout = () => {
    setLogout();
  };

  return (
    <div className={'content__header'}>
      <h1 className={'content__title'}>
        <T id={'setup.left_side.title'} />
      </h1>

      <p className={'content__text'}>
        <T id={'setup.left_side.description'} />
      </p>

      <div className={'content__organization'}>
        <span className="signout">
          <a onClick={onClickLogout} href="#">
            <T id={'sign_out'} />
          </a>
        </span>
      </div>
    </div>
  );
}

/**
 * Wizard setup left section.
 */
export function SetupLeftSection() {
  return (
    <section className={'setup-page__left-section'}>
      <div className={'content'}>
        <div className={'content__logo'}>
          <BrandLogo width={160} tone="white" />
        </div>
        <SetupLeftSectionHeader />
        <SetupLeftSectionFooter />
      </div>
    </section>
  );
}
