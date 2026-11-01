import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.QUEUE_HOST || 'localhost',
  port: parseInt(process.env.QUEUE_PORT, 10) || 6379,
  // Optional BullMQ key prefix (default `bull`): servers sharing one Redis
  // with different prefixes don't take each other's jobs.
  prefix: process.env.QUEUE_PREFIX || undefined,
}));
