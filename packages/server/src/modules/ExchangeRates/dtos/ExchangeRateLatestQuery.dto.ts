import { IsOptional, IsString, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query of `GET /exchange-rates/latest`.
 *
 * The API takes `from_currency` / `to_currency`, but the global
 * SerializeInterceptor camel-cases query keys before validation, so the
 * properties are named as the server receives them (`fromCurrency`). Naming
 * them in snake case made the whitelist drop the currencies, and the rate
 * fell back to base-to-base (always 1).
 */
export class ExchangeRateLatestQueryDto {
  @ApiPropertyOptional({
    name: 'from_currency',
    description: 'The source currency code (ISO 4217)',
    example: 'USD',
  })
  @IsOptional()
  @IsString()
  @Length(3, 3, { message: 'Currency code must be 3 characters (ISO 4217)' })
  fromCurrency?: string;

  @ApiPropertyOptional({
    name: 'to_currency',
    description: 'The target currency code (ISO 4217)',
    example: 'EUR',
  })
  @IsOptional()
  @IsString()
  @Length(3, 3, { message: 'Currency code must be 3 characters (ISO 4217)' })
  toCurrency?: string;
}
