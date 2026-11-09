import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClsMiddleware } from 'nestjs-cls';
import * as path from 'path';
import './utils/moment-mysql';
import { AppModule } from './modules/App/App.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { registerUnhandledRejectionLogger } from './utils/unhandled-rejection-logger';

global.__public_dirname = path.join(__dirname, '..', 'public');
global.__static_dirname = path.join(__dirname, '../static');
global.__views_dirname = path.join(global.__static_dirname, '/views');
global.__images_dirname = path.join(global.__static_dirname, '/images');

// Log stray promise rejections instead of letting one stop the server.
registerUnhandledRejectionLogger();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.set('query parser', 'extended');
  app.setGlobalPrefix('/api');

  // create and mount the middleware manually here
  app.use(new ClsMiddleware({}).use);

  const config = new DocumentBuilder()
    .setTitle('LEGA')
    .setDescription('Financial accounting software')
    .setVersion('1.0')
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger', app, documentFactory);

  // Every PDF (and the PDF attached to emails) is made by Gotenberg.
  if (!process.env.GOTENBERG_URL) {
    new Logger('Gotenberg').warn(
      'GOTENBERG_URL is not set: PDF downloads and PDF email attachments will fail.',
    );
  }

  // On SIGTERM/SIGINT (a deploy, a restart) run the shutdown hooks: the
  // queue workers finish their running jobs, the work queued after the last
  // saves runs, and the database pools close (DatabasePoolsShutdown).
  app.enableShutdownHooks();

  // SERVER_PORT is shared with the webapp dev server and the browser tests;
  // PORT still works on its own.
  await app.listen(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
}
bootstrap();
