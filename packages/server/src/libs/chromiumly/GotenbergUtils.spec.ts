import * as http from 'http';
import { AddressInfo } from 'net';
import * as FormData from 'form-data';
import { GotenbergUtils, PDF_RENDER_FAILED } from './GotenbergUtils';

/**
 * The PDF service call: a failure is a clear 502 PDF_RENDER_FAILED, never
 * "nothing" (which crashed the caller) and never an error page passed on
 * as the PDF.
 */
// Real HTTP round trips to a local server: allow for a busy machine (the
// default 5 s timed out once with the whole suite running in parallel).
jest.setTimeout(30_000);

describe('GotenbergUtils.fetch', () => {
  let server: http.Server;
  let base: string;
  let reply: (res: http.ServerResponse) => void;
  const previousUrl = process.env.GOTENBERG_URL;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => reply(res));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.GOTENBERG_URL = base;
  });

  afterAll(async () => {
    process.env.GOTENBERG_URL = previousUrl;
    await new Promise((resolve) => server.close(resolve));
  });

  const form = () => {
    const data = new FormData();
    data.append('index.html', Buffer.from('<p>hi</p>'), 'index.html');
    return data;
  };

  const failsWith502 = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toMatchObject({
      errorType: PDF_RENDER_FAILED,
      httpStatus: 502,
      message: 'The PDF service is unavailable, try again.',
    });
  };

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the PDF', async () => {
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.7 fake'));
    };
    const pdf = await GotenbergUtils.fetch(`${base}/convert`, form());
    expect(pdf.toString('latin1')).toBe('%PDF-1.7 fake');
  });

  it('an error status is a 502, not the error page as the PDF', async () => {
    reply = (res) => {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<h1>Service Unavailable</h1>');
    };
    await failsWith502(GotenbergUtils.fetch(`${base}/convert`, form()));
  });

  it('a 200 that is not a PDF is a 502', async () => {
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>oops</html>');
    };
    await failsWith502(GotenbergUtils.fetch(`${base}/convert`, form()));
  });

  it('an unreachable service is a 502', async () => {
    await failsWith502(
      GotenbergUtils.fetch('http://127.0.0.1:1/convert', form()),
    );
  });

  it('no GOTENBERG_URL is a 502', async () => {
    process.env.GOTENBERG_URL = '';
    try {
      await failsWith502(GotenbergUtils.fetch(`${base}/convert`, form()));
    } finally {
      process.env.GOTENBERG_URL = base;
    }
  });
});
