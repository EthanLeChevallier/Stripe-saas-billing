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

  const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jui', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

  const buildRevenueTrend = (invoices: Array<{ created?: number; amount_paid?: number; status?: string; paid?: boolean }>) => {
    const now = new Date();
    const values = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      const total = invoices
        .filter((invoice) => invoice.paid && invoice.status === 'paid' && invoice.created)
        .reduce((sum, invoice) => {
          const createdAt = new Date(Number(invoice.created) * 1000);
          if (`${createdAt.getFullYear()}-${createdAt.getMonth()}` !== monthKey) {
            return sum;
          }
          return sum + Number(invoice.amount_paid ?? 0);
        }, 0);

      return { month: monthNames[date.getMonth()], value: total / 100 };
    });

    return values;
  };

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
      const [eventsResult, outboxStatus, stripeSnapshot] = await Promise.all([
        pool.query(`
        SELECT
          COUNT(*)::int AS processed_events,
          COUNT(*) FILTER (WHERE event_type = 'checkout.session.completed')::int AS checkout_completed,
          COUNT(*) FILTER (WHERE event_type = 'invoice.payment_succeeded')::int AS invoice_paid,
          COUNT(*) FILTER (WHERE event_type = 'customer.subscription.deleted')::int AS cancellations
        FROM processed_events
      `),
        pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM notification_outbox
        GROUP BY status
      `),
        Promise.all([
          stripe.invoices.list({ limit: 50 }).catch(() => ({ data: [] })),
          stripe.subscriptions.list({ limit: 50, status: 'all' }).catch(() => ({ data: [] })),
          stripe.checkout.sessions.list({ limit: 50 }).catch(() => ({ data: [] })),
        ]),
      ]);

      const summaryRow = eventsResult.rows?.[0] ?? {};
      const processedEvents = Number(summaryRow.processed_events ?? 0);
      const checkoutCompleted = Number(summaryRow.checkout_completed ?? 0);
      const invoicePaid = Number(summaryRow.invoice_paid ?? 0);
      const cancellations = Number(summaryRow.cancellations ?? 0);

      const invoiceList = Array.isArray((stripeSnapshot as Array<{ data?: any[] }>)[0]?.data) ? ((stripeSnapshot as Array<{ data?: any[] }>)[0].data ?? []) : [];
      const subscriptionList = Array.isArray((stripeSnapshot as Array<{ data?: any[] }>)[1]?.data) ? ((stripeSnapshot as Array<{ data?: any[] }>)[1].data ?? []) : [];
      const checkoutSessionList = Array.isArray((stripeSnapshot as Array<{ data?: any[] }>)[2]?.data) ? ((stripeSnapshot as Array<{ data?: any[] }>)[2].data ?? []) : [];

      const paidInvoices = invoiceList.filter((invoice: any) => invoice?.paid && invoice?.status === 'paid');
      const successfulPayments = paidInvoices.length;
      const liveRevenue = paidInvoices.reduce((sum: number, invoice: any) => sum + Number(invoice.amount_paid ?? 0), 0) / 100;
      const activeSubscriptions = subscriptionList.filter((subscription: any) => ['active', 'trialing', 'past_due'].includes(subscription?.status)).length;
      const completedCheckouts = checkoutSessionList.filter((session: any) => session?.payment_status === 'paid' || session?.status === 'complete').length;

      const outboxRows = outboxStatus.rows ?? [];
      const outboxMap = Object.fromEntries(outboxRows.map((row) => [row.status, Number(row.count)]));
      const pendingNotifications = Number(outboxMap.pending ?? 0);
      const sentNotifications = Number(outboxMap.sent ?? 0);
      const failedNotifications = Number(outboxMap.failed ?? 0);

      const recentPayments = invoiceList.slice(0, 3).map((invoice: any) => {
        const firstLine = invoice?.lines?.data?.[0] ?? {};
        const planName = firstLine?.description || firstLine?.price?.nickname || 'Abonnement';
        return {
          id: invoice.id ?? 'invoice_unknown',
          plan: planName,
          amount: Number(invoice.amount_paid ?? invoice.total ?? 0),
          customer: invoice.customer ?? 'Client Stripe',
          status: invoice.paid ? 'paid' : 'pending',
          date: new Date(Number(invoice.created ?? Date.now() / 1000) * 1000).toISOString(),
        };
      });

      const revenueTrend = buildRevenueTrend(invoiceList);

      const summary = {
        processedEvents: Number(processedEvents ?? 0),
        successfulPayments: successfulPayments || Number(invoicePaid ?? 0),
        activeSubscriptions: Math.max(0, activeSubscriptions || Number(checkoutCompleted ?? 0) - Number(cancellations ?? 0)),
        pendingNotifications,
        sentNotifications,
        failedNotifications,
      };

      response.status(200).json({
        source: 'Stripe API + processed webhook events + local outbox',
        dashboardNote: 'This is a demo operational snapshot combining live Stripe data and the local webhook/outbox trail used by the app.',
        summary,
        revenueTrend,
        teamHealth: [
          { name: 'Stripe API', score: invoiceList.length > 0 ? 98 : 0, detail: 'Live invoice and subscription data retrieved from Stripe' },
          { name: 'Webhook', score: Number(processedEvents ?? 0) > 0 ? 98 : 0, detail: 'Stripe events received and stored' },
          { name: 'Slack', score: pendingNotifications > 0 ? 76 : 92, detail: 'Outbox delivery status' },
          { name: 'Database', score: 94, detail: 'Postgres idempotence is enabled' },
        ],
        conversionFunnel: [
          { label: 'Sessions Checkout', value: completedCheckouts || 0 },
          { label: 'Abonnements actifs', value: activeSubscriptions || 0 },
          { label: 'Paiements réussis', value: successfulPayments || 0 },
          { label: 'Annulations', value: cancellations || 0 },
        ],
        recentPayments,
        revenue: {
          total: Number((liveRevenue || 0).toFixed(2)),
          currency: 'EUR',
        },
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