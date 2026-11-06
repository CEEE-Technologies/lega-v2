import { registerAs } from '@nestjs/config';

export default registerAs('lemonsqueezy', () => ({
  apiKey: process.env.LEMONSQUEEZY_API_KEY,
  storeId: process.env.LEMONSQUEEZY_STORE_ID,
  webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET,
  // Where the customer goes after paying: the app's billing page by default.
  redirectTo:
    process.env.LEMONSQUEEZY_REDIRECT_TO ||
    (process.env.BASE_URL
      ? `${process.env.BASE_URL.replace(/\/+$/, '')}/billing`
      : undefined),
}));
