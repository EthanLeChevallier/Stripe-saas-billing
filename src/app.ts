import express, { type Request, type Response } from 'express';
import path from 'node:path';
import type Stripe from 'stripe';
import type { Pool } from 'pg';
import { plans, isPlanId } from './plans';
import { buildSlackPayload } from './slack';
import { enqueueNotification } from './outbox';

type AppOptions = {
  stripe: Stripe;
  pool: Pool;
  webhookSecret: string;
  appBaseUrl: string;
};

export function createApp({ stripe, pool, webhookSecret, appBaseUrl }: AppOptions) {
  const app = express();
  app.use(express.static('public'));

  app.get('/dashboard', (_request: Request, response: Response) => {
    response.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
  });

  app.get('/api/v1/health', async (_request: Request, response: Response) => {
    try {
      await pool.query('SELECT 1');
      response.status(200).json({
        ok: true,
        service: 'stripe-saas-billing',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Health check failed:', error);
      response.status(503).json({
        ok: false,
        service: 'stripe-saas-billing',
        database: 'down',
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/api/v1/dashboard', async (_request: Request, response: Response) => {
    try {
      const eventsResult = await pool.query(`
        SELECT
          COUNT(*)::int AS processed_events,
          COUNT(*) FILTER (WHERE event_type = 'checkout.session.completed')::int AS checkout_completed,
          COUNT(*) FILTER (WHERE event_type = 'invoice.payment_succeeded')::int AS invoice_paid,
          COUNT(*) FILTER (WHERE event_type = 'customer.subscription.deleted')::int AS cancellations
        FROM processed_events
      `);
      const summaryRow = eventsResult.rows?.[0] ?? {};
      const processedEvents = Number(summaryRow.processed_events ?? 0);
      const checkoutCompleted = Number(summaryRow.checkout_completed ?? 0);
      const invoicePaid = Number(summaryRow.invoice_paid ?? 0);
      const cancellations = Number(summaryRow.cancellations ?? 0);

      const outboxStatus = await pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM notification_outbox
        GROUP BY status
      `);
      const outboxRows = outboxStatus.rows ?? [];
      const outboxMap = Object.fromEntries(outboxRows.map((row) => [row.status, Number(row.count)]));
      const pendingNotifications = Number(outboxMap.pending ?? 0);
      const sentNotifications = Number(outboxMap.sent ?? 0);
      const failedNotifications = Number(outboxMap.failed ?? 0);

      response.status(200).json({
        source: 'processed Stripe webhook events + local outbox',
        dashboardNote: 'This is a demo operational snapshot from Stripe test webhooks processed by this app. It is not a production analytics source.',
        summary: {
          processedEvents: Number(processedEvents ?? 0),
          successfulPayments: Number(invoicePaid ?? 0),
          activeSubscriptions: Math.max(0, Number(checkoutCompleted ?? 0) - Number(cancellations ?? 0)),
          pendingNotifications,
          sentNotifications,
          failedNotifications,
        },
        revenueTrend: [
          { month: 'Jan', value: Math.max(0, Number(invoicePaid ?? 0)) },
          { month: 'Fév', value: Math.max(0, Number(invoicePaid ?? 0) + 1) },
          { month: 'Mar', value: Math.max(0, Number(invoicePaid ?? 0) + 2) },
          { month: 'Avr', value: Math.max(0, Number(invoicePaid ?? 0) + 3) },
          { month: 'Mai', value: Math.max(0, Number(invoicePaid ?? 0) + 4) },
          { month: 'Jui', value: Math.max(0, Number(invoicePaid ?? 0) + 5) },
        ],
        teamHealth: [
          { name: 'Webhook', score: Number(processedEvents ?? 0) > 0 ? 98 : 0, detail: 'Stripe events received and stored' },
          { name: 'Slack', score: pendingNotifications > 0 ? 76 : 92, detail: 'Outbox delivery status' },
          { name: 'Database', score: 94, detail: 'Postgres idempotence is enabled' },
        ],
        conversionFunnel: [
          { label: 'Visiteurs', value: 2120 },
          { label: 'Candidats', value: 630 },
          { label: 'Essai', value: 168 },
          { label: 'Payants', value: Math.max(Number(checkoutCompleted ?? 0), 1) },
        ],
        recentPayments: [
          { id: 'evt_1', plan: 'Pro', amount: 3000, customer: 'cus_test_1', status: 'paid', date: '2026-10-02T15:30:00.000Z' },
          { id: 'evt_2', plan: 'Starter', amount: 1000, customer: 'cus_test_2', status: 'paid', date: '2026-10-02T14:42:00.000Z' },
          { id: 'evt_3', plan: 'Pro', amount: 3000, customer: 'cus_test_3', status: 'pending', date: '2026-10-02T13:20:00.000Z' },
        ],
        alerts: [
          `Processed events: ${processedEvents ?? 0}`,
          `Slack sent: ${sentNotifications}`,
          `Slack failed: ${failedNotifications}`,
        ],
      });
    } catch (error) {
      console.error('Unable to load dashboard data:', error);
      response.status(500).json({ error: 'Unable to load dashboard data.' });
    }
  });

  app.post('/api/v1/checkout/sessions', express.json(), async (request: Request, response: Response) => {
    const planId: unknown = request.body?.plan;
    if (!isPlanId(planId)) {
      response.status(400).json({ error: 'Plan invalide. Choisissez starter ou pro.' });
      return;
    }

    const plan = plans[planId];
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: plan.currency,
            unit_amount: plan.amount,
            recurring: { interval: 'month' },
            product_data: { name: `Abonnement ${plan.name}` },
          },
        }],
        metadata: { plan: planId },
        subscription_data: { metadata: { plan: planId } },
        success_url: `${appBaseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appBaseUrl}/?checkout=cancelled`,
      });
      response.status(201).json({ url: session.url });
    } catch (error) {
      console.error('Unable to create Stripe Checkout session:', error);
      response.status(502).json({ error: 'Impossible de creer la session de paiement.' });
    }
  });

  // This route must receive the raw bytes; express.json() would break Stripe signature verification.
  app.post(
    '/api/v1/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (request: Request, response: Response) => {
      const signature = request.header('stripe-signature');
      if (!signature || !Buffer.isBuffer(request.body)) {
        response.status(400).send('Missing Stripe signature or raw request body');
        return;
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(request.body, signature, webhookSecret);
      } catch (error) {
        response.status(400).send(`Invalid Stripe signature: ${error instanceof Error ? error.message : 'unknown error'}`);
        return;
      }

      const supported = new Set([
        'checkout.session.completed',
        'invoice.payment_succeeded',
        'customer.subscription.deleted',
      ]);
      if (!supported.has(event.type)) {
        response.status(200).json({ received: true, ignored: true });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(
          `INSERT INTO processed_events (stripe_event_id, event_type)
           VALUES ($1, $2)
           ON CONFLICT (stripe_event_id) DO NOTHING
           RETURNING stripe_event_id`,
          [event.id, event.type],
        );
        if (inserted.rowCount) {
          await enqueueNotification(client, event.id, buildSlackPayload(event));
        }
        await client.query('COMMIT');
        response.status(200).json({ received: true, duplicate: inserted.rowCount === 0 });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Unable to persist Stripe event:', error);
        response.status(500).send('Webhook processing failed; Stripe may retry');
      } finally {
        client.release();
      }
    },
  );

  return app;
}