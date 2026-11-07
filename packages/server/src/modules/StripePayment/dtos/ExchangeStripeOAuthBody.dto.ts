import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ExchangeStripeOAuthBodyDto {
  @ApiProperty({
    description: 'Authorization code returned by Stripe OAuth',
    example: 'ac_xxx',
  })
  @IsString()
  code: string;

  @ApiProperty({
    description:
      'The state of the Stripe connect link, returned by Stripe unchanged',
    required: false,
  })
  @IsOptional()
  @IsString()
  state?: string;
}
