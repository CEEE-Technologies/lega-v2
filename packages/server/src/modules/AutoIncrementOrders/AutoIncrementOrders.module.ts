import { Module } from '@nestjs/common';
import { TenancyDatabaseModule } from '../Tenancy/TenancyDB/TenancyDB.module';
import { AutoIncrementOrdersService } from './AutoIncrementOrders.service';
import { ImportModule } from '../Import/Import.module';

@Module({
  imports: [TenancyDatabaseModule, ImportModule],
  controllers: [],
  providers: [AutoIncrementOrdersService],
  exports: [AutoIncrementOrdersService],
})
export class AutoIncrementOrdersModule {}
