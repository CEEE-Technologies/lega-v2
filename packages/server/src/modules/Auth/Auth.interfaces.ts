import { ModelObject } from 'objection';
import { SystemUser } from '../System/models/SystemUser';
import { TenantModel } from '../System/models/TenantModel';
import { AuthSignupDto } from './dtos/AuthSignup.dto';

export interface JwtPayload {
  /** The authenticated user's id. */
  sub: string;
  /** The login's session version when the token was made. */
  sv?: number;
  iss?: string;
  aud?: string;
  iat: number;
  exp: number;
}

export interface IAuthSigningInEventPayload {
  email: string;
  password: string;
  user: ModelObject<SystemUser>;
}

export interface IAuthSignedInEventPayload {
  email: string;
  password: string;
  user: ModelObject<SystemUser>;
}

export interface IAuthSigningUpEventPayload {
  signupDTO: AuthSignupDto;
}

export interface IAuthSignedUpEventPayload {
  signupDTO: AuthSignupDto;
  tenant: TenantModel;
  user: SystemUser;
}

export interface IAuthSignInPOJO {
  user: ModelObject<SystemUser>;
  token: string;
  tenant: ModelObject<TenantModel>;
}

export interface IAuthResetedPasswordEventPayload {
  user: SystemUser;
  token: string;
  password: string;
}

export interface IAuthSendingResetPassword {
  user: SystemUser;
}

/**
 * The reset token isn't in the payload: the mail job creates it, stores its
 * hash and mails the raw token, so the raw token is never stored.
 */
export interface IAuthSendedResetPassword {
  user: SystemUser;
}

export interface IAuthGetMetaPOJO {
  signupDisabled: boolean;
}

export interface IAuthSignUpVerifingEventPayload {
  email: string;
  verifyToken: string;
  userId: number;
}

export interface IAuthSignUpVerifiedEventPayload {
  email: string;
  verifyToken: string;
  userId: number;
}

export interface ISignUpConfigmResendedEventPayload {
  user: SystemUser;
}
