import { StripePaymentService } from './StripePaymentService';
import { Knex } from 'knex';
import { StripeOAuthCodeGrantedEventPayload } from './types';
import { Inject, Injectable } from '@nestjs/common';
import { UnitOfWork } from '../Tenancy/TenancyDB/UnitOfWork.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentIntegration } from './models/PaymentIntegration.model';
import { events } from '@/common/events/events';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { StripeConnectStateService } from './StripeConnectState.service';

@Injectable()
export class ExchangeStripeOAuthTokenService {
  constructor(
    private readonly stripePaymentService: StripePaymentService,
    private readonly eventPublisher: EventEmitter2,
    private readonly uow: UnitOfWork,

    @Inject(PaymentIntegration.name)
    private readonly paymentIntegrationModel: TenantModelProxy<
      typeof PaymentIntegration
    >,

    private readonly connectState: StripeConnectStateService,
  ) {}

  /**
   * Exchange stripe oauth authorization code to access token and user id.
   * @param {string} authorizationCode
   * @param {string} state - The state of the connect link the user started.
   */
  public async excahngeStripeOAuthToken(
    authorizationCode: string,
    state?: string,
  ) {
    // Refuses a return link the signed-in user didn't start here, so nobody
    // can connect their own Stripe account to this organization.
    this.connectState.consume(state);

    const stripe = this.stripePaymentService.stripe;

    const response = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code: authorizationCode,
    });
    // const accessToken = response.access_token;
    // const refreshToken = response.refresh_token;
    const stripeUserId = response.stripe_user_id;

    // Retrieves details of the Stripe account.
    const account = await stripe.accounts.retrieve(stripeUserId, {
      expand: ['business_profile'],
    });
    const companyName = account.business_profile?.name || 'Unknown name';
    const paymentEnabled = account.charges_enabled;
    const payoutEnabled = account.payouts_enabled;

    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Stores the details of the Stripe account.
      const paymentIntegration = await this.paymentIntegrationModel()
        .query(trx)
        .insert({
          name: companyName,
          service: 'Stripe',
          accountId: stripeUserId,
          paymentEnabled,
          payoutEnabled,
        });
      // Triggers `onStripeOAuthCodeGranted` event.
      await this.eventPublisher.emitAsync(
        events.stripeIntegration.onOAuthCodeGranted,
        {
          paymentIntegrationId: paymentIntegration.id,
          trx,
        } as StripeOAuthCodeGrantedEventPayload,
      );
    });
  }
}
