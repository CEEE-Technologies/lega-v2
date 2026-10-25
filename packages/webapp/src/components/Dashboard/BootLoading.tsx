import { Spinner } from '@blueprintjs/core';
import { useContext } from 'react';
import { StartupLoadingContext } from './StartupLoadingContext';
import { useSplashLoadingState } from '@/hooks/state';

/** Keep the startup splash in place while a lazy route is being downloaded. */
export function BootLoading({
  showSpinner = false,
}: {
  showSpinner?: boolean;
}) {
  const splashVisible = useContext(StartupLoadingContext);
  useSplashLoadingState(!showSpinner || splashVisible);
  return showSpinner ? (
    <div className="dashboard__fallback-loading">
      <Spinner size={40} />
    </div>
  ) : null;
}
