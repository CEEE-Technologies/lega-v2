import { IsMoney } from '@/common/decorators/Validators';
import { IsBoolean, IsDateString, IsNumber, IsString } from 'class-validator';

export class UncategorizedBankTransactionDto {
  @IsDateString()
  date: Date | string;

  @IsNumber()
  accountId: number;

  @IsMoney()
  amount: number;

  @IsString()
  currencyCode: string;

  @IsString()
  payee?: string;

  @IsString()
  description?: string;

  @IsString()
  referenceNo?: string | null;

  @IsString()
  plaidTransactionId?: string | null;

  @IsBoolean()
  pending?: boolean;

  @IsString()
  pendingPlaidTransactionId?: string | null;

  @IsString()
  batch?: string;
}
