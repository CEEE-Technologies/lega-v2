import { ReactNode } from 'react';
import styled from 'styled-components';
import { BrandLogo } from '@/components/Brand/BrandLogo';

interface AuthContainerProps {
  children: ReactNode;
}

export function AuthContainer({ children }: AuthContainerProps) {
  return (
    <AuthPage>
      <AuthInsider>
        <AuthLogo>
          <BrandLogo width={184} />
        </AuthLogo>

        {children}
      </AuthInsider>
    </AuthPage>
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
