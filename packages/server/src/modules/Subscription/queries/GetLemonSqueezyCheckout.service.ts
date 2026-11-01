import { createCheckout } from '@lemonsqueezy/lemonsqueezy.js';
import { configureLemonSqueezy } from '../utils';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';

@Injectable()
export class GetLemonSqueezyCheckoutService {
  constructor(
    private readonly configService: ConfigService,

    private readonly tenancyContext: TenancyContext,
  ) {}

  /**
   * Retrieves the LemonSqueezy checkout url.
   * @param {number} variantId
   * @param {SystemUser} user
   */
  async getCheckout(variantId: number) {
    configureLemonSqueezy();
    const user = await this.tenancyContext.getSystemUser();
    // The organization being paid for, not the user's first organization.
    const tenant = await this.tenancyContext.getTenant();

    return createCheckout(
      this.configService.get('lemonsqueezy.storeId'),
      variantId,
      {
        checkoutOptions: {
          embed: true,
          media: true,
          logo: true,
        },
        checkoutData: {
          email: user.email,
          custom: {
            user_id: user.id + '',
            tenant_id: tenant.id + '',
          },
        },
        productOptions: {
          enabledVariants: [variantId],
          redirectUrl: this.configService.get('lemonSqueezy.redirectTo'),
          receiptButtonText: 'Go to Dashboard',
          receiptThankYouNote: 'Thank you for signing up to Lemon Stand!',
        },
      },
    );
  }
}
