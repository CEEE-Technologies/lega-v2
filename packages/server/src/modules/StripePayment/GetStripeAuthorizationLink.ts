import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeConnectStateService } from './StripeConnectState.service';

@Injectable()
export class GetStripeAuthorizationLinkService {
  constructor(
    private readonly config: ConfigService,
    private readonly connectState: StripeConnectStateService,
  ) {}

  /**
   * The Stripe connect link. Its `state` names the user and organization
   * that started it, and is checked when Stripe sends the user back.
   * @returns {string}
   */
  public getStripeAuthLink() {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.get('stripePayment.clientId') || '',
      scope: 'read_write',
      redirect_uri: this.config.get('stripePayment.redirectUrl') || '',
      state: this.connectState.create(),
    });
    return `https://connect.stripe.com/oauth/v2/authorize?${params.toString()}`;
  }
}
