import { fromCents } from '@bigcapital/utils';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { CreatePaymentReceiveStripePayment } from '../CreatePaymentReceivedStripePayment';
import {
  StripeCheckoutSessionCompletedEventPayload,
  StripeWebhookEventPayload,
} from '../StripePayment.types';
import { events } from '@/common/events/events';
import { PaymentIntegration } from '../models/PaymentIntegration.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { PaymentReceived } from '@/modules/PaymentReceived/models/PaymentReceived';
import { isStripeCheckoutSignatureValid } from '../StripeCheckoutSignature';

@Injectable()
export class StripeWebhooksSubscriber {
  private readonly logger = new Logger('StripeWebhooks');

  constructor(
    private readonly createPaymentReceiveStripePayment: CreatePaymentReceiveStripePayment,
    private readonly clsService: ClsService,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    @Inject(PaymentIntegration.name)
    private readonly paymentIntegrationModel: TenantModelProxy<
      typeof PaymentIntegration
    >,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,

    @Inject(SaleInvoice.name)
    private readonly saleInvoiceModel: TenantModelProxy<typeof SaleInvoice>,

    @Inject(PaymentReceived.name)
    private readonly paymentReceivedModel: TenantModelProxy<
      typeof PaymentReceived
    >,

    private readonly configService: ConfigService,
  ) {}

  /**
   * Handles the checkout session completed webhook event.
   * @param {StripeCheckoutSessionCompletedEventPayload} payload -
   */
  @OnEvent(events.stripeWebhooks.onCheckoutSessionCompleted)
  async handleCheckoutSessionCompleted({
    event,
  }: StripeCheckoutSessionCompletedEventPayload) {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const tenantId = parseInt(metadata.tenantId, 10);
    const saleInvoiceId = parseInt(metadata.saleInvoiceId, 10);

    // Anyone can create a checkout on their own Stripe account with any
    // notes, so the notes alone prove nothing. Only a checkout this server
    // signed for the invoice's payment link is recorded.
    const isSigned = isStripeCheckoutSignatureValid(
      this.configService.get<string>('jwt.secret'),
      { tenantId, saleInvoiceId, paymentLinkId: metadata.paymentLinkId },
      metadata.checkoutSignature,
    );
    if (!isSigned) {
      return this.ignore(event, 'the checkout was not created by this server');
    }
    const tenant = await this.tenantModel.query().findOne({ id: tenantId });

    if (!tenant) {
      return this.ignore(event, 'the organization does not exist');
    }

    const user = await this.systemUserModel
      .query()
      .findOne({
        tenantId: tenant.id,
      })
      .modify('active')
      .throwIfNotFound();

    this.clsService.set('organizationId', tenant.organizationId);
    this.clsService.set('userId', user.id);

    const invoice = await this.saleInvoiceModel()
      .query()
      .findById(saleInvoiceId)
      .withGraphFetched('paymentMethods.paymentIntegration');

    if (!invoice) {
      return this.ignore(event, 'the invoice does not exist');
    }
    // The money must have gone to the Stripe account connected to this
    // invoice's organization.
    const stripeAccountId = invoice.paymentMethods?.find(
      (method) => method.paymentIntegration?.service === 'Stripe',
    )?.paymentIntegration?.accountId;

    if (!stripeAccountId || event.account !== stripeAccountId) {
      return this.ignore(event, 'it was paid to another Stripe account');
    }
    if (
      String(session.currency || '').toUpperCase() !==
      String(invoice.currencyCode || '').toUpperCase()
    ) {
      return this.ignore(event, 'the currency does not match the invoice');
    }
    // Stripe sends a notice again when it isn't sure it arrived. The
    // checkout id is kept as the payment reference, so it is recorded once.
    const alreadyRecorded = await this.paymentReceivedModel()
      .query()
      .findOne({ referenceNo: session.id });

    if (alreadyRecorded) {
      return this.ignore(event, 'the payment is already recorded');
    }
    // Get the amount from the event
    const amount = session.amount_total;

    // Convert from Stripe amount (cents) to normal amount (dollars)
    const amountInDollars = fromCents(amount);

    // Creates a new payment received transaction.
    await this.createPaymentReceiveStripePayment.createPaymentReceived(
      saleInvoiceId,
      amountInDollars,
      session.id,
    );
  }

  /**
   * Logs a payment notice that is not recorded. The webhook still answers
   * 200, so Stripe doesn't send it again.
   * @param {any} event - The Stripe event.
   * @param {string} reason - Why it is not recorded.
   */
  private ignore(event: any, reason: string): void {
    this.logger.warn(
      `Stripe checkout ${event?.data?.object?.id} (event ${event?.id}) not recorded: ${reason}.`,
    );
  }

  /**
   * Handles the account updated.
   * @param {StripeWebhookEventPayload}
   */
  @OnEvent(events.stripeWebhooks.onAccountUpdated)
  async handleAccountUpdated({ event }: StripeWebhookEventPayload) {
    const { metadata } = event.data.object;
    const account = event.data.object;
    const tenantId = parseInt(metadata.tenantId, 10);

    if (!metadata?.paymentIntegrationId || !metadata.tenantId) return;

    // Find the tenant or throw not found error.
    await this.tenantModel.query().findById(tenantId).throwIfNotFound();

    // Check if the account capabilities are active
    if (account.capabilities.card_payments === 'active') {
      // Marks the payment method integration as active.
      await this.paymentIntegrationModel()
        .query()
        .findById(metadata?.paymentIntegrationId)
        .patch({
          active: true,
        });
    }
  }
}
