import { AutoIncrementOrdersService } from './AutoIncrementOrders.service';
import { ImportAls } from '../Import/ImportALS';

const makeSettingsStore = (nextNumber: string) => {
  const values: Record<string, any> = {
    'payment_receives.next_number': nextNumber,
    'payment_receives.auto_increment': true,
  };
  return {
    values,
    get: ({ group, key }) => values[`${group}.${key}`],
    set: ({ group, key }, value) => {
      values[`${group}.${key}`] = value;
    },
    save: jest.fn().mockResolvedValue(undefined),
  };
};

describe('AutoIncrementOrdersService.incrementSettingsNextNumber', () => {
  it('advances the next number outside an import', async () => {
    const store = makeSettingsStore('00031');
    const service = new AutoIncrementOrdersService(
      () => store as any,
      new ImportAls(),
    );

    await service.incrementSettingsNextNumber('payment_receives');

    expect(store.values['payment_receives.next_number']).toBe('00032');
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('leaves the next number alone during an import preview', async () => {
    const store = makeSettingsStore('00031');
    const importAls = new ImportAls();
    const service = new AutoIncrementOrdersService(
      () => store as any,
      importAls,
    );

    await importAls.runPreview(() =>
      service.incrementSettingsNextNumber('payment_receives'),
    );

    expect(store.values['payment_receives.next_number']).toBe('00031');
    expect(store.save).not.toHaveBeenCalled();
  });

  it('still advances the next number when the import is committed', async () => {
    const store = makeSettingsStore('00031');
    const importAls = new ImportAls();
    const service = new AutoIncrementOrdersService(
      () => store as any,
      importAls,
    );

    await importAls.runCommit(() =>
      service.incrementSettingsNextNumber('payment_receives'),
    );

    expect(store.values['payment_receives.next_number']).toBe('00032');
  });
});
