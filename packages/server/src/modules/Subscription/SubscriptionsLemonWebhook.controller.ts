import {
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LemonSqueezyWebhooks } from './webhooks/LemonSqueezyWebhooks';
import { PublicRoute } from '../Auth/guards/jwt.guard';

/**
 * Lemon Squeezy calls this route without a sign-in token, so it is public.
 * The request signature is checked before anything else.
 */
@Controller('/webhooks/lemon')
@ApiTags('Subscriptions')
@PublicRoute()
export class SubscriptionsLemonWebhook {
  constructor(private readonly lemonWebhooksService: LemonSqueezyWebhooks) {}

  /**
   * Listens to Lemon Squeezy webhooks events.
   */
  @Post('/')
  @HttpCode(200)
  @ApiOperation({ summary: 'Listen to Lemon Squeezy webhooks' })
  async lemonWebhooks(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string,
  ) {
    await this.lemonWebhooksService.handlePostWebhook(
      req.rawBody,
      signature ?? '',
    );
    return { received: true };
  }
}
