import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';

export const STRIPE_CONNECT_STATE_INVALID = 'STRIPE_CONNECT_STATE_INVALID';
export const STRIPE_CONNECT_STATE_MESSAGE =
  "This Stripe connection wasn't started from your account.";

/** How long a Stripe connect link stays usable. */
const STATE_LIFETIME_MS = 15 * 60 * 1000;

interface StripeConnectStatePayload {
  /** System user id. */
  u: number;
  /** Organization id. */
  o: string;
  /** Random value, so each link is different and is used once. */
  n: string;
  /** Expiry, in milliseconds since 1970. */
  e: number;
}

/**
 * Makes and checks the `state` value of the Stripe connect link. The state is
 * signed by the server and names the user and organization that started the
 * connection, so a return link made by someone else is refused.
 */
@Injectable()
export class StripeConnectStateService {
  /** States already used, with their expiry. */
  private readonly usedStates = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly cls: ClsService,
  ) {}

  private sign(body: string): string {
    const secret = this.configService.get<string>('jwt.secret');
    return createHmac('sha256', `stripe-connect-state:${secret}`)
      .update(body)
      .digest('base64url');
  }

  /**
   * Creates a state for the signed-in user and the current organization.
   * @returns {string}
   */
  public create(): string {
    const payload: StripeConnectStatePayload = {
      u: this.cls.get<number>('userId'),
      o: this.cls.get<string>('organizationId'),
      n: randomBytes(16).toString('base64url'),
      e: Date.now() + STATE_LIFETIME_MS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /**
   * Checks the state came from a link the signed-in user made in the current
   * organization, hasn't expired and hasn't been used. Marks it used.
   * @param {string | undefined} state
   * @throws {ServiceError}
   */
  public consume(state: string | undefined): void {
    const payload = this.verify(state);
    const now = Date.now();

    for (const [used, expiry] of this.usedStates) {
      if (expiry < now) this.usedStates.delete(used);
    }
    if (
      !payload ||
      payload.e < now ||
      payload.u !== this.cls.get<number>('userId') ||
      payload.o !== this.cls.get<string>('organizationId') ||
      this.usedStates.has(payload.n)
    ) {
      throw new ServiceError(
        STRIPE_CONNECT_STATE_INVALID,
        STRIPE_CONNECT_STATE_MESSAGE,
      );
    }
    this.usedStates.set(payload.n, payload.e);
  }

  private verify(state: string | undefined): StripeConnectStatePayload | null {
    if (!state || typeof state !== 'string') return null;
    const [body, signature] = state.split('.');
    if (!body || !signature) return null;

    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
}
