import * as FormData from 'form-data';
import axios from 'axios';
import { HttpStatus, Logger } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { Chromiumly } from './Chromiumly';

export const PDF_RENDER_FAILED = 'PDF_RENDER_FAILED';
export const PDF_RENDER_FAILED_MESSAGE =
  'The PDF service is unavailable, try again.';

/** How long a PDF may take to render before giving up. */
const RENDER_TIMEOUT_MS = 60_000;

const logger = new Logger('Gotenberg');

/** The error a failed render gives the user: 502, "try again". */
export const pdfRenderFailed = () =>
  new ServiceError(
    PDF_RENDER_FAILED,
    PDF_RENDER_FAILED_MESSAGE,
    undefined,
    HttpStatus.BAD_GATEWAY,
  );

/** Whether the bytes are a PDF (every PDF starts with `%PDF-`). */
export const isPdf = (content: Buffer) =>
  content.length >= 5 && content.subarray(0, 5).toString('latin1') === '%PDF-';

export class GotenbergUtils {
  public static assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
      throw new Error(message);
    }
  }

  /**
   * Sends the form to the PDF service and returns the PDF.
   *
   * Throws PDF_RENDER_FAILED (502) when the service isn't set, can't be
   * reached, times out, answers with an error status, or answers with
   * something that isn't a PDF. It used to log the error and return
   * nothing (the caller then crashed: a 500), and its bare `Axios` client
   * took an error status as success, so an error page was sent, or
   * emailed, as the PDF.
   */
  public static async fetch(endpoint: string, data: FormData): Promise<Buffer> {
    if (!Chromiumly.GOTENBERG_ENDPOINT) {
      logger.error('GOTENBERG_URL is not set: PDFs cannot be made.');
      throw pdfRenderFailed();
    }
    let content: Buffer;
    try {
      const response = await axios.post(endpoint, data, {
        headers: data.getHeaders(),
        responseType: 'arraybuffer',
        timeout: RENDER_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      content = Buffer.from(response.data);
    } catch (error) {
      const status = error?.response?.status;
      logger.error(
        `The PDF service failed${status ? ` (HTTP ${status})` : ''}: ${error?.message ?? error}`,
      );
      throw pdfRenderFailed();
    }
    if (!isPdf(content)) {
      logger.error(
        `The PDF service answered with something that isn't a PDF (${content.length} bytes).`,
      );
      throw pdfRenderFailed();
    }
    return content;
  }
}
