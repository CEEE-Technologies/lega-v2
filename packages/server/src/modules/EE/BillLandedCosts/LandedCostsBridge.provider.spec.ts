import { ServiceError } from '@/modules/Items/ServiceError';
import { LandedCostsBridgeProvider } from './LandedCostsBridge.provider';
import { ERRORS } from './utils';

describe('LandedCostsBridgeProvider', () => {
  let bridge: { register: jest.Mock };
  let transactionLandedCostEntries: {
    validateLandedCostEntriesNotDeleted: jest.Mock;
    validateLocatedCostEntriesSmallerThanNewEntries: jest.Mock;
  };
  let billLandedCostModel: jest.Mock;
  let itemModel: jest.Mock;
  let provider: LandedCostsBridgeProvider;

  const mockBillLandedCostQuery = (whereResult: any) => {
    const where = jest.fn().mockResolvedValue(whereResult);
    const query = jest.fn(() => ({ where }));
    billLandedCostModel.mockReturnValue({ query });
    return { query, where };
  };

  const mockItemsQuery = (items: any[]) => {
    const whereIn = jest.fn().mockResolvedValue(items);
    const query = jest.fn(() => ({ whereIn }));
    itemModel.mockReturnValue({ query });
    return { query, whereIn };
  };

  beforeEach(() => {
    bridge = { register: jest.fn() };
    transactionLandedCostEntries = {
      validateLandedCostEntriesNotDeleted: jest.fn(),
      validateLocatedCostEntriesSmallerThanNewEntries: jest.fn(),
    };
    billLandedCostModel = jest.fn();
    itemModel = jest.fn();
    provider = new LandedCostsBridgeProvider(
      bridge as any,
      transactionLandedCostEntries as any,
      billLandedCostModel as any,
      itemModel as any,
    );
  });

  describe('onModuleInit', () => {
    it('registers itself on the bills bridge', () => {
      provider.onModuleInit();

      expect(bridge.register).toHaveBeenCalledWith(provider);
    });
  });

  describe('validateBillHasNoLandedCosts', () => {
    it('throws an error when the bill has associated landed costs', async () => {
      const { where } = mockBillLandedCostQuery([{ id: 1 }]);

      try {
        await provider.validateBillHasNoLandedCosts(7);
        throw new Error('Expected the provider to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        expect((error as ServiceError).errorType).toBe(
          ERRORS.BILL_HAS_ASSOCIATED_LANDED_COSTS,
        );
      }
      expect(where).toHaveBeenCalledWith('billId', 7);
    });

    it('resolves when the bill has no associated landed costs', async () => {
      mockBillLandedCostQuery([]);

      await expect(
        provider.validateBillHasNoLandedCosts(7),
      ).resolves.toBeUndefined();
    });
  });

  describe('validateBillEntries', () => {
    it('throws an error when a landed cost entry is an inventory item', async () => {
      mockItemsQuery([
        { id: 1, type: 'inventory' },
        { id: 2, type: 'service' },
      ]);

      try {
        await provider.validateBillEntries([
          { itemId: 1, landedCost: true },
          { itemId: 2, landedCost: true },
        ]);
        throw new Error('Expected the provider to throw');
      } catch (error) {
        expect((error as ServiceError).errorType).toBe(
          ERRORS.LANDED_COST_ENTRIES_SHOULD_NOT_BE_INVENTORY_ITEMS,
        );
      }
    });

    it('resolves when the landed cost entries are service or non-inventory items', async () => {
      mockItemsQuery([
        { id: 1, type: 'inventory' },
        { id: 2, type: 'service' },
        { id: 3, type: 'non-inventory' },
      ]);

      await expect(
        provider.validateBillEntries([
          { itemId: 1, landedCost: false },
          { itemId: 2, landedCost: true },
          { itemId: 3, landedCost: true },
        ]),
      ).resolves.toBeUndefined();
    });
  });

  describe('validateBillEditEntries', () => {
    it('delegates both validations to the landed cost entries service', () => {
      const oldEntries = [{ id: 1 }];
      const newEntries = [{ id: 1 }];

      provider.validateBillEditEntries(oldEntries as any, newEntries as any);

      expect(
        transactionLandedCostEntries.validateLandedCostEntriesNotDeleted,
      ).toHaveBeenCalledWith(oldEntries, newEntries);
      expect(
        transactionLandedCostEntries.validateLocatedCostEntriesSmallerThanNewEntries,
      ).toHaveBeenCalledWith(oldEntries, newEntries);
    });
  });
});
