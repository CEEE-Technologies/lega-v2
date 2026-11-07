import { createCheckout } from '@lemonsqueezy/lemonsqueezy.js';
import lemonsqueezyConfig from '@/common/config/lemonsqueezy';
import { GetLemonSqueezyCheckoutService } from './GetLemonSqueezyCheckout.service';

jest.mock('@lemonsqueezy/lemonsqueezy.js', () => ({
  createCheckout: jest.fn(async () => ({ data: {} })),
  lemonSqueezySetup: jest.fn(),
}));
jest.mock('../utils', () => ({ configureLemonSqueezy: jest.fn() }));

describe('GetLemonSqueezyCheckoutService', () => {
  const previousBaseUrl = process.env.BASE_URL;
  const previousRedirect = process.env.LEMONSQUEEZY_REDIRECT_TO;
  afterEach(() => {
    process.env.BASE_URL = previousBaseUrl;
    process.env.LEMONSQUEEZY_REDIRECT_TO = previousRedirect;
  });

  it('sends the customer back to the billing page after paying', async () => {
    process.env.BASE_URL = 'https://app.example.com';
    delete process.env.LEMONSQUEEZY_REDIRECT_TO;

    // Reads the settings the way ConfigService does: `group.key`.
    const settings = { lemonsqueezy: (lemonsqueezyConfig as any)() };
    const configService = {
      get: (key: string) =>
        key.split('.').reduce((value, part) => value?.[part], settings as any),
    };
    const tenancyContext = {
      getSystemUser: async () => ({ id: 7, email: 'owner@example.com' }),
      getTenant: async () => ({ id: 3 }),
    };
    const service = new GetLemonSqueezyCheckoutService(
      configService as any,
      tenancyContext as any,
    );
    await service.getCheckout(42);

    const [, , options] = (createCheckout as jest.Mock).mock.calls[0];
    expect(options.productOptions.redirectUrl).toBe(
      'https://app.example.com/billing',
    );
  });

  it('uses LEMONSQUEEZY_REDIRECT_TO when it is set', () => {
    process.env.LEMONSQUEEZY_REDIRECT_TO = 'https://billing.example.com/back';
    expect((lemonsqueezyConfig as any)().redirectTo).toBe(
      'https://billing.example.com/back',
    );
  });
});
