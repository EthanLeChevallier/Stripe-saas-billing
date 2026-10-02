import Stripe from 'stripe';
import { Pool } from 'pg';
import { config } from './config';
import { createApp } from './app';
import { postSlackMessage } from './slack';
import { startOutboxWorker } from './outbox';

const stripe = new Stripe(config.stripeSecretKey);
const pool = new Pool({ connectionString: config.databaseUrl });
const app = createApp({
  stripe,
  pool,
  webhookSecret: config.stripeWebhookSecret,
  appBaseUrl: config.appBaseUrl,
});

const stopWorker = startOutboxWorker(
  pool,
  config.slackWebhookUrl,
  config.outboxPollIntervalMs,
  postSlackMessage,
);

const server = app.listen(config.port, () => {
  console.log(`Billing demo listening at ${config.appBaseUrl}`);
});

async function shutdown(): Promise<void> {
  stopWorker();
  server.close();
  await pool.end();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());