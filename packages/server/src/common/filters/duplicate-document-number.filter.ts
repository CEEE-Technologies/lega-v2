import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { UniqueViolationError } from 'objection';
import { getDocumentNumberIndexLabel } from '../constants/document-numbers';

/**
 * Two saves can still pick the same typed number at the same moment; the
 * unique index on document numbers refuses the second one. This answers
 * that with a clear 409 instead of a server error. Other unique violations
 * keep the default 500 answer.
 */
@Catch(UniqueViolationError)
export class DuplicateDocumentNumberFilter implements ExceptionFilter {
  private readonly logger = new Logger(DuplicateDocumentNumberFilter.name);

  catch(
    exception: InstanceType<typeof UniqueViolationError>,
    host: ArgumentsHost,
  ) {
    const response = host.switchToHttp().getResponse<Response>();
    const label = getDocumentNumberIndexLabel(exception.constraint);

    if (!label) {
      this.logger.error(exception.message, exception.stack);
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      });
      return;
    }
    const status = HttpStatus.CONFLICT;
    response.status(status).json({
      errors: [
        {
          statusCode: status,
          type: 'DOCUMENT_NUMBER_EXISTS',
          message: `${label} number is already used by another ${label.toLowerCase()}.`,
        },
      ],
    });
  }
}
