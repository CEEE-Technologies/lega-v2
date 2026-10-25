import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { createBrowserHistory, History } from 'history';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Router, Switch, Route, useLocation } from 'react-router-dom';
import '@/style/App.scss';
import { SplashScreen, DashboardThemeProvider } from '../components';
import { queryConfig } from '../hooks/query/base';
import AppIntlLoader from './AppIntlLoader';
import { BootLoading } from './Dashboard/BootLoading';
import { EnsureUserEmailNotVerified } from './Guards/EnsureUserEmailNotVerified';
import { EnsureAuthenticated } from '@/components/Guards/EnsureAuthenticated';
import { GlobalErrors } from '@/containers/GlobalErrors/GlobalErrors';

const DashboardPrivatePages = lazy(
  () => import('@/components/Dashboard/PrivatePages'),
);
const AuthenticationPage = lazy(() =>
  import('@/containers/Authentication/AuthenticationPage').then((m) => ({
    default: m.AuthenticationPage,
  })),
);
const EmailConfirmation = lazy(() =>
  import('@/containers/Authentication/EmailConfirmation').then((m) => ({
    default: m.EmailConfirmation,
  })),
);
const RegisterVerify = lazy(() =>
  import('@/containers/Authentication/RegisterVerify').then((m) => ({
    default: m.RegisterVerify,
  })),
);
const PaymentPortalPage = lazy(() =>
  import('@/containers/PaymentPortal/PaymentPortalPage').then((m) => ({
    default: m.PaymentPortalPage,
  })),
);

function RouteTheme() {
  const { pathname } = useLocation();
  useEffect(() => window.legaTheme.apply(), [pathname]);
  return null;
}

/** App inner. */
function AppInsider({ history }: { history: History }) {
  return (
    <div className="App">
      <DashboardThemeProvider>
        <Suspense fallback={<BootLoading />}>
          <Router history={history}>
            <RouteTheme />
            <Switch>
              <Route path={'/auth/register/verify'}>
                <EnsureAuthenticated>
                  <EnsureUserEmailNotVerified>
                    <RegisterVerify />
                  </EnsureUserEmailNotVerified>
                </EnsureAuthenticated>
              </Route>

              <Route
                path={'/auth/email_confirmation'}
                children={<EmailConfirmation />}
              />
              <Route path={'/auth'} children={<AuthenticationPage />} />
              <Route
                path={'/payment/:linkId'}
                children={<PaymentPortalPage />}
              />
              <Route path={'/'} children={<DashboardPrivatePages />} />
            </Switch>
          </Router>
        </Suspense>

        <GlobalErrors />
      </DashboardThemeProvider>
    </div>
  );
}

/**
 * Core application.
 */
export default function App() {
  // Browser history.
  const [history] = useState(() => createBrowserHistory());

  // Query client.
  const [queryClient] = useState(() => new QueryClient(queryConfig));

  return (
    <QueryClientProvider client={queryClient}>
      <SplashScreen>
        <AppIntlLoader>
          <AppInsider history={history} />
        </AppIntlLoader>
      </SplashScreen>

      {import.meta.env.DEV &&
        import.meta.env.VITE_REACT_QUERY_DEVTOOLS === 'true' &&
        !navigator.webdriver && <ReactQueryDevtools initialIsOpen />}
    </QueryClientProvider>
  );
}
