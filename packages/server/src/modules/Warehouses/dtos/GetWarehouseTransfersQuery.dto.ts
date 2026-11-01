import { DynamicFilterQueryDto } from '@/modules/DynamicListing/dtos/DynamicFilterQuery.dto';

/**
 * Warehouse transfers list query: the standard list options (page, search,
 * tab/view, sort and filters). Fields not listed here are dropped by the
 * validation pipe, so the tab and sort must be declared to reach the query.
 */
export class GetWarehouseTransfersQueryDto extends DynamicFilterQueryDto {}
