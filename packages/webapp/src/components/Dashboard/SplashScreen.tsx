import * as FF from 'fp-ts/function';
import { useLayoutEffect, useState } from 'react';
import LegaLoading from './LegaLoading';
import { StartupLoadingContext } from './StartupLoadingContext';
import { withDashboard } from '@/containers/Dashboard/withDashboard';

interface SplashScreenProps {
  splashScreenLoading: boolean;
  children?: React.ReactNode;
}

function SplashScreenComponent({
  splashScreenLoading,
  children,
}: SplashScreenProps) {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);

  useLayoutEffect(() => {
    if (splashScreenLoading) {
      setVisible(true);
      setLeaving(false);
      return;
    }
    let secondFrame = 0;
    let fadeTimer: ReturnType<typeof setTimeout>;
    // Consecutive boot stages hand off after committing. Give the next stage
    // two frames to register before revealing the workspace underneath.
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        setLeaving(true);
        fadeTimer = setTimeout(() => {
          setVisible(false);
        }, 180);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      clearTimeout(fadeTimer);
    };
  }, [splashScreenLoading]);

  return (
    <StartupLoadingContext.Provider value={visible}>
      {visible && (
        <LegaLoading className={leaving ? 'is-leaving' : undefined} />
      )}
      {children}
    </StartupLoadingContext.Provider>
  );
}

export const SplashScreen = FF.pipe(
  SplashScreenComponent,
  withDashboard(({ splashScreenLoading }) => ({
    splashScreenLoading,
  })),
);
