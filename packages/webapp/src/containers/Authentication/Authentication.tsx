import { Spinner } from '@blueprintjs/core';
import { Suspense } from 'react';
import BodyClassName from 'react-body-classname';
import { Route, Switch, useLocation } from 'react-router-dom';
import { TransitionGroup, CSSTransition } from 'react-transition-group';
import styled from 'styled-components';
import { AuthMetaBootProvider } from './AuthMetaBoot';
import { Box } from '@/components';
import { BrandLogo } from '@/components/Brand/BrandLogo';
import authenticationRoutes from '@/routes/authentication';

import '@/style/pages/Authentication/Auth.scss';

export function Authentication() {
  return (
    <BodyClassName className={'authentication'}>
      <AuthPage>
        <AuthInsider>
          <AuthLogo>
            <BrandLogo width={184} />
          </AuthLogo>

          <AuthMetaBootProvider>
            <Suspense
              fallback={
                <Box style={{ marginTop: '5rem' }}>
                  <Spinner size={30} />
                </Box>
              }
            >
              <AuthenticationRoutes />
            </Suspense>
          </AuthMetaBootProvider>
        </AuthInsider>
      </AuthPage>
    </BodyClassName>
  );
}

function AuthenticationRoutes() {
  const location = useLocation();
  const locationKey = location.pathname;

  return (
    <TransitionGroup>
      <CSSTransition
        timeout={500}
        key={locationKey}
        classNames="authTransition"
      >
        <Switch>
          {authenticationRoutes.map((route, index) => (
            <Route key={index} path={route.path} component={route.component} />
          ))}
        </Switch>
      </CSSTransition>
    </TransitionGroup>
  );
}

// Centers the form in the space to the right of the decorative panel.
const AuthPage = styled.div`
  box-sizing: border-box;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 24px 48px calc(var(--auth-panel-width, 0px) + 24px);
`;
const AuthInsider = styled.div`
  width: 100%;
  max-width: 384px;
`;

const AuthLogo = styled.div`
  text-align: center;
  margin-bottom: 32px;
`;
