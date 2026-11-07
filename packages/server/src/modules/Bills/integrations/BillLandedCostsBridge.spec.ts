import {
  BillLandedCostsBridge,
  IBillLandedCostsProvider,
} from './BillLandedCostsBridge';

describe('BillLandedCostsBridge', () => {
  let bridge: BillLandedCostsBridge;

  beforeEach(() => {
    bridge = new BillLandedCostsBridge();
  });

  describe('without a registered provider', () => {
    it('resolves the validations as no-ops', async () => {
      await expect(
        bridge.validateBillHasNoLandedCosts(1),
      ).resolves.toBeUndefined();
      await expect(
        bridge.validateBillEntries([{ itemId: 1, landedCost: true }]),
      ).resolves.toBeUndefined();
      expect(() => bridge.validateBillEditEntries([], [])).not.toThrow();
    });
  });

  describe('with a registered provider', () => {
    const buildProvider = (): jest.Mocked<IBillLandedCostsProvider> => ({
      validateBillHasNoLandedCosts: jest.fn().mockResolvedValue(undefined),
      validateBillNotLandedCostSource: jest.fn().mockResolvedValue(undefined),
      validateBillEntries: jest.fn().mockResolvedValue(undefined),
      validateBillEditEntries: jest.fn(),
    });

    it('delegates every call to the provider', async () => {
      const provider = buildProvider();
      bridge.register(provider);

      await bridge.validateBillHasNoLandedCosts(7);
      await bridge.validateBillNotLandedCostSource(8);
      await bridge.validateBillEntries([{ itemId: 1, landedCost: true }]);
      bridge.validateBillEditEntries([{ id: 1 }], [{ id: 1 }]);

      expect(provider.validateBillHasNoLandedCosts).toHaveBeenCalledWith(
        7,
        undefined,
      );
      expect(provider.validateBillNotLandedCostSource).toHaveBeenCalledWith(
        8,
        undefined,
      );
      expect(provider.validateBillEntries).toHaveBeenCalledWith([
        { itemId: 1, landedCost: true },
      ]);
      expect(provider.validateBillEditEntries).toHaveBeenCalledWith(
        [{ id: 1 }],
        [{ id: 1 }],
      );
    });
  });
});
