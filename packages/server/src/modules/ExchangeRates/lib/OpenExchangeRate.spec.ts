import Axios from 'axios';
import { OpenExchangeRate } from './OpenExchangeRate';
import { EchangeRateErrors } from './types';

describe('OpenExchangeRate.latest', () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns the provider's rate for the asked pair", async () => {
    const get = jest
      .spyOn(Axios, 'get')
      .mockResolvedValue({ data: { rates: { LKR: 300.25 } } });

    const rate = await new OpenExchangeRate('app-id').latest('USD', 'LKR');

    expect(rate).toBe(300.25);
    expect(get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ base: 'USD', symbols: 'LKR' }),
      }),
    );
  });

  it('throws instead of answering 1 when the provider has no rate', async () => {
    jest.spyOn(Axios, 'get').mockResolvedValue({ data: { rates: {} } });

    await expect(
      new OpenExchangeRate('app-id').latest('USD', 'XYZ'),
    ).rejects.toMatchObject({
      errorType: EchangeRateErrors.EX_RATE_NOT_AVAILABLE,
      message: 'No exchange rate available for USD to XYZ.',
    });
  });

  it('throws on a zero rate too', async () => {
    jest.spyOn(Axios, 'get').mockResolvedValue({ data: { rates: { EUR: 0 } } });

    await expect(
      new OpenExchangeRate('app-id').latest('USD', 'EUR'),
    ).rejects.toMatchObject({
      errorType: EchangeRateErrors.EX_RATE_NOT_AVAILABLE,
    });
  });

  it('asks for an app id when none is set up', async () => {
    const get = jest.spyOn(Axios, 'get');
    const previous = process.env.OPEN_EXCHANGE_RATE_APP_ID;
    process.env.OPEN_EXCHANGE_RATE_APP_ID = '';

    await expect(
      new OpenExchangeRate().latest('USD', 'EUR'),
    ).rejects.toMatchObject({
      errorType: EchangeRateErrors.EX_RATE_SERVICE_API_KEY_REQUIRED,
    });
    expect(get).not.toHaveBeenCalled();
    process.env.OPEN_EXCHANGE_RATE_APP_ID = previous;
  });
});
