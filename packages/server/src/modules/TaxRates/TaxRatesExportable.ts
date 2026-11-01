import { ExportableService } from '../Export/decorators/ExportableModel.decorator';
import { Exportable } from '../Export/Exportable';
import { TaxRatesApplication } from './TaxRate.application';
import { Injectable } from '@nestjs/common';

@Injectable()
// The webapp's resource name; ResourceService maps it to TaxRateModel.
@ExportableService({ name: 'TaxRate' })
export class TaxRatesExportable extends Exportable {
  constructor(private readonly taxRatesApplication: TaxRatesApplication) {
    super();
  }

  /**
   * Retrieves the accounts data to exportable sheet.
   */
  public exportable() {
    return this.taxRatesApplication.getTaxRates();
  }
}
