import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import {
  compareSignatures,
  createHmacSignature,
  webhookHasData,
  webhookHasMeta,
} from '../utils';
import { Plan } from '../models/Plan';
import { SubscriptionApplication } from '../SubscriptionApplication';
import { TenantModel } from '@/modules/System/models/TenantModel';

@Injectable()
export class LemonSqueezyWebhooks {
  constructor(
    private readonly subscriptionApp: SubscriptionApplication,
    private readonly configService: ConfigService,
    private readonly clsService: ClsService,

    @Inject(Plan.name)
    private readonly planModel: typeof Plan,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,
  ) {}

  /**
   * Handles the Lemon Squeezy webhooks.
   * Checks the signature first, then processes the event for the
   * organization named in the event's custom data.
   * @param {Buffer|string} rawData - The raw request body, as signed.
   * @param {string} signature - The `X-Signature` header.
   * @returns {Promise<void>}
   */
  public async handlePostWebhook(
    rawData: Buffer | string | undefined,
    signature: string,
  ): Promise<void> {
    // No Lemon Squeezy API call is made here, so the API key isn't needed.
    const secret = this.configService.get('lemonsqueezy.webhookSecret');

    if (!secret) {
      throw new InternalServerErrorException(
        'Lemon Squeezy webhook secret is not configured.',
      );
    }
    if (!signature || !rawData) {
      throw new BadRequestException('Invalid signature');
    }
    const hmacSignature = createHmacSignature(secret, rawData);

    if (!compareSignatures(hmacSignature, signature)) {
      throw new BadRequestException('Invalid signature');
    }
    // Process the body exactly as signed. The parsed request body has had
    // its keys renamed (snake_case to camelCase) by the global interceptor.
    let data: Record<string, any>;
    try {
      data = JSON.parse(rawData.toString());
    } catch (_error) {
      throw new BadRequestException('Data invalid');
    }
    const eventName = data?.meta?.event_name;

    if (typeof eventName !== 'string') {
      throw new BadRequestException('Data invalid');
    }
    // Only subscription events change anything, and they need the
    // organization. Order and license events are acknowledged and ignored.
    if (!eventName.startsWith('subscription_')) {
      return;
    }
    if (!webhookHasMeta(data)) {
      throw new BadRequestException('Data invalid');
    }
    await this.setTenantContext(data);
    await this.processWebhookEvent(data);
  }

  /**
   * Sets the organization (and user) of the event as the current context,
   * so the subscription is updated for that organization.
   * @param {Record<string, any>} eventBody
   */
  private async setTenantContext(eventBody: Record<string, any>) {
    const tenantId = Number(eventBody.meta?.custom_data?.tenant_id);
    const userId = Number(eventBody.meta?.custom_data?.user_id);

    const tenant = tenantId
      ? await this.tenantModel.query().findById(tenantId)
      : null;

    if (!tenant) {
      throw new BadRequestException(
        'The webhook event is not linked to a known organization.',
      );
    }
    this.clsService.set('organizationId', tenant.organizationId);

    if (userId) {
      this.clsService.set('userId', userId);
    }
  }

  /**
   * This action will process a webhook event in the database.
   * @param {unknown} eventBody -
   * @returns {Promise<void>}
   */
  private async processWebhookEvent(eventBody): Promise<void> {
    const webhookEvent = eventBody.meta.event_name;

    const subscriptionSlug = 'main';

    if (!webhookHasMeta(eventBody)) {
      throw new Error("Event body is missing the 'meta' property.");
    } else if (webhookHasData(eventBody)) {
      if (webhookEvent.startsWith('subscription_payment_')) {
        // Marks the main subscription payment as succeed.
        if (webhookEvent === 'subscription_payment_success') {
          await this.subscriptionApp.markSubscriptionPaymentSuccessed(
            subscriptionSlug,
          );
          // Marks the main subscription payment as failed.
        } else if (webhookEvent === 'subscription_payment_failed') {
          await this.subscriptionApp.markSubscriptionPaymentFailed(
            subscriptionSlug,
          );
        }
        // Save subscription invoices; eventBody is a SubscriptionInvoice
        // Not implemented.
      } else if (webhookEvent.startsWith('subscription_')) {
        // Save subscription events; obj is a Subscription
        const attributes = eventBody.data.attributes;
        const variantId = attributes.variant_id as string;

        // We assume that the Plan table is up to date.
        const plan = await this.planModel
          .query()
          .findOne('lemonVariantId', variantId);

        // Update the subscription in the database.
        const _priceId = attributes.first_subscription_item.price_id;
        const subscriptionId = eventBody.data.id;

        // Throw error early if the given lemon variant id is not associated to any plan.
        if (!plan) {
          throw new Error(`Plan with variantId ${variantId} not found.`);
        }
        // Create a new subscription of the tenant.
        if (webhookEvent === 'subscription_created') {
          await this.subscriptionApp.createNewSubscription(
            plan.slug,
            subscriptionSlug,
            { lemonSqueezyId: subscriptionId },
          );
          // Cancel the given subscription of the organization.
        } else if (webhookEvent === 'subscription_cancelled') {
          await this.subscriptionApp.cancelSubscription(subscriptionSlug);
        } else if (webhookEvent === 'subscription_plan_changed') {
          await this.subscriptionApp.markSubscriptionPlanChanged(
            plan.slug,
            subscriptionSlug,
          );
        } else if (webhookEvent === 'subscription_resumed') {
          await this.subscriptionApp.resumeSubscription(subscriptionSlug);
        }
      } else if (webhookEvent.startsWith('order_')) {
        // Save orders; eventBody is a "Order"
        /* Not implemented */
      } else if (webhookEvent.startsWith('license_')) {
        // Save license keys; eventBody is a "License key"
        /* Not implemented */
      }
    }
  }
}
