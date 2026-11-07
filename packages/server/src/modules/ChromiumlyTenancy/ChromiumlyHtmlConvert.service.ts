import { Injectable } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { PageProperties, PdfFormat } from '@/libs/chromiumly/_types';
import { HtmlConverter } from '@/libs/chromiumly/HTMLConvert';

@Injectable()
export class ChromiumlyHtmlConvert {
  /**
   * Writes the HTML to a new private temporary folder. Gotenberg needs the
   * file to be called `index.html`; the folder name is random.
   * @param {string} content - HTML content.
   * @returns {Promise<[string, () => Promise<void>]>} The file path and a
   * function that deletes the folder.
   */
  async writeTempHtmlFile(
    content: string,
  ): Promise<[string, () => Promise<void>]> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lega-print-'));
    const filePath = path.join(dir, 'index.html');

    await fs.writeFile(filePath, content, { mode: 0o600 });

    const cleanup = async () => {
      await fs.rm(dir, { recursive: true, force: true });
    };
    return [filePath, cleanup];
  }

  /**
   * Converts the given HTML content to PDF. The HTML is sent to Gotenberg
   * with the request, so nothing is written to the public folder.
   * @param {string} html
   * @param {PageProperties} properties
   * @param {PdfFormat} pdfFormat
   * @returns {Array<Buffer>}
   */
  async convert(
    html: string,
    properties?: PageProperties,
    pdfFormat?: PdfFormat,
  ): Promise<Buffer> {
    const [filePath, cleanupTempFile] = await this.writeTempHtmlFile(html);

    try {
      const htmlConverter = new HtmlConverter();

      return await htmlConverter.convert({
        html: filePath,
        properties,
        pdfFormat,
      });
    } finally {
      await cleanupTempFile();
    }
  }
}
