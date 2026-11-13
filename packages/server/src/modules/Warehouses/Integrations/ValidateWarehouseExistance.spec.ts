import { ValidateWarehouseExistance } from './ValidateWarehouseExistance';
import { WarehousesDTOValidators } from './WarehousesDTOValidators';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from './constants';

/**
 * Q2: the warehouse check waits for the lookup, so an unknown warehouse is
 * refused with "warehouse not found" (it used to always pass).
 */
describe('ValidateWarehouseExistance', () => {
  const build = (found: unknown) => {
    const findById = jest.fn().mockResolvedValue(found);
    const warehouseModel = () => ({
      query: () => ({
        findById,
        whereIn: jest.fn().mockResolvedValue([]),
      }),
    });
    return {
      service: new ValidateWarehouseExistance(warehouseModel as any),
      findById,
    };
  };

  it('refuses a warehouse that does not exist', async () => {
    const { service, findById } = build(undefined);

    await expect(service.validateWarehouseExistance(999)).rejects.toMatchObject(
      { errorType: ERRORS.WAREHOUSE_ID_NOT_FOUND },
    );
    expect(findById).toHaveBeenCalledWith(999);
  });

  it('accepts a warehouse that exists', async () => {
    const { service } = build({ id: 1 });

    await expect(
      service.validateWarehouseExistance(1),
    ).resolves.toBeUndefined();
  });

  it('the document check refuses an unknown warehouse while warehouses are on', async () => {
    const { service } = build(undefined);
    const validators = new WarehousesDTOValidators(service, {
      isMultiWarehousesActive: async () => true,
    } as any);

    await expect(
      validators.validateDTOWarehouseWhenActive({
        warehouseId: 999,
        entries: [{}],
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
