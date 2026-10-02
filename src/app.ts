import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Stripe from 'stripe';
import type { Pool } from 'pg';
import { plans, isPlanId } from './plans';
import { buildCheckoutCancellationPayload, buildSlackPayload } from './slack';
import { enqueueNotification } from './outbox';

type StripePage<T> = { data: T[]; has_more: boolean };

async function collectStripePages<T extends { id: string }>(
  fetchPage: (startingAfter?: string) => Promise<StripePage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await fetchPage(startingAfter);
    items.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !startingAfter) break;
  } while (startingAfter);

  return items;
}

type AppOptions = {
  stripe: Stripe;
  pool: Pool;
  webhookSecret: string;
  appBaseUrl: string;
};

export function createApp({ stripe, pool, webhookSecret, appBaseUrl }: AppOptions) {
  const app = express();
  app.use(express.static('public'));

  const buildRevenueTrend = (invoices: Stripe.Invoice[], startDate: Date) =>
    Array.from({ length: 13 }, (_, index) => {
      const date = new Date(startDate.getFullYear(), startDate.getMonth() + index, 1);
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      const total = invoices.reduce((sum, invoice) => {
        if (!invoice.paid || invoice.status !== 'paid' || !invoice.created) return sum;
        const createdAt = new Date(invoice.created * 1000);
        if (`${createdAt.getFullYear()}-${createdAt.getMonth()}` !== monthKey) return sum;
        return sum + (invoice.currency === 'eur' ? invoice.amount_paid : 0);
      }, 0);

      return {
        month: new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' }).format(date),
        value: total / 100,
      };
    });

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
      const now = new Date();
      const trendStart = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      const startTimestamp = Math.floor(trendStart.getTime() / 1000);
      const [eventsResult, outboxStatus, checkoutAbandonmentsResult, stripeSnapshot] = await Promise.all([
        pool.query(`
        SELECT
          COUNT(*)::int AS processed_events
        FROM processed_events
      `),
        pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM notification_outbox
        GROUP BY status
      `),
        pool.query(
          `SELECT COUNT(*)::int AS checkout_abandonments
           FROM checkout_cancellations
           WHERE notified_at >= to_timestamp($1) AND notified_at <= now()`,
          [startTimestamp],
        ),
        Promise.all([
          collectStripePages((startingAfter) => stripe.invoices.list({
            limit: 100,
            created: { gte: startTimestamp },
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          })),
          collectStripePages((startingAfter) => stripe.subscriptions.list({
            limit: 100,
            status: 'all',
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          })),
          collectStripePages((startingAfter) => stripe.checkout.sessions.list({
            limit: 100,
            created: { gte: startTimestamp },
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          })),
        ]),
      ]);

      const summaryRow = eventsResult.rows?.[0] ?? {};
      const processedEvents = Number(summaryRow.processed_events ?? 0);
      const checkoutAbandonments = Number(checkoutAbandonmentsResult.rows?.[0]?.checkout_abandonments ?? 0);
      const [invoiceList, subscriptionList, checkoutSessionList] = stripeSnapshot;
      const paidInvoices = invoiceList.filter((invoice) => invoice.paid && invoice.status === 'paid');
      const successfulPayments = paidInvoices.length;
      const activeSubscriptions = subscriptionList.filter((subscription) => ['active', 'trialing'].includes(subscription.status)).length;
      const completedCheckouts = checkoutSessionList.filter((session) => session.status === 'complete').length;

      const outboxRows = outboxStatus.rows ?? [];
      const outboxMap = Object.fromEntries(outboxRows.map((row) => [row.status, Number(row.count)]));
      const pendingNotifications = Number(outboxMap.pending ?? 0);
      const sentNotifications = Number(outboxMap.sent ?? 0);
      const failedNotifications = Number(outboxMap.failed ?? 0);

      const recentPayments = invoiceList.slice(0, 5).map((invoice) => {
        const firstLine = invoice.lines.data[0];
        const planName = firstLine?.description || firstLine?.price?.nickname || 'Abonnement';
        return {
          id: invoice.id,
          plan: planName,
          amount: invoice.amount_paid ?? invoice.total ?? 0,
          currency: invoice.currency,
          customer: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? 'Client Stripe',
          status: invoice.status ?? 'unknown',
          date: new Date(invoice.created * 1000).toISOString(),
        };
      });

      const revenueTrend = buildRevenueTrend(invoiceList, trendStart);
      const liveRevenue = paidInvoices.reduce((sum, invoice) => sum + (invoice.currency === 'eur' ? invoice.amount_paid : 0), 0) / 100;

      const summary = {
        processedEvents,
        successfulPayments,
        activeSubscriptions,
        pendingNotifications,
        sentNotifications,
        failedNotifications,
      };
      const slackStatus = failedNotifications > 0
        ? `${failedNotifications} en erreur`
        : pendingNotifications > 0
          ? `${pendingNotifications} en attente`
          : 'À jour';

      response.status(200).json({
        source: 'Stripe API + processed webhook events + local outbox',
        dashboardNote: 'Les factures et checkouts couvrent les 12 derniers mois calendaires jusqu’au mois en cours. Les abandons de Checkout viennent des retours clients vérifiés et des sessions expirées, comptés une fois par session ; les abonnements actifs reflètent leur statut actuel.',
        summary,
        revenueTrend,
        revenuePeriod: {
          start: trendStart.toISOString(),
          end: now.toISOString(),
        },
        teamHealth: [
          { name: 'Stripe API', status: 'Connectée', detail: 'Données récupérées en direct' },
          { name: 'Webhooks', status: `${processedEvents} traités`, detail: 'Événements enregistrés localement' },
          { name: 'Slack', status: slackStatus, detail: `${sentNotifications} notifications envoyées` },
          { name: 'PostgreSQL', status: 'Connectée', detail: 'Événements et notifications persistés' },
        ],
        conversionFunnel: [
          { label: 'Checkouts créés', value: checkoutSessionList.length },
          { label: 'Checkouts terminés', value: completedCheckouts },
          { label: 'Abonnements actifs', value: activeSubscriptions },
          { label: 'Checkouts abandonnés', value: checkoutAbandonments },
        ],
        recentPayments,
        revenue: {
          total: Number(liveRevenue.toFixed(2)),
          currency: 'EUR',
        },
        alerts: [
          `Événements traités : ${processedEvents}`,
          `Notifications Slack envoyées : ${sentNotifications}`,
          `Notifications Slack en erreur : ${failedNotifications}`,
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
      const cancellationToken = randomUUID();
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
        cancel_url: `${appBaseUrl}/?checkout=cancelled&cancel_token=${cancellationToken}`,
      });
      await pool.query(
        `INSERT INTO checkout_cancellations (cancellation_token, stripe_session_id, plan_id)
         VALUES ($1, $2, $3)`,
        [cancellationToken, session.id, planId],
      );
      response.status(201).json({ url: session.url });
    } catch (error) {
      console.error('Unable to create Stripe Checkout session:', error);
      response.status(502).json({ error: 'Impossible de creer la session de paiement.' });
    }
  });

  app.post('/api/v1/checkout/cancellations', express.json(), async (request: Request, response: Response) => {
    const token: unknown = request.body?.token;
    if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token)) {
      response.status(400).json({ error: 'Jeton de retour Checkout invalide.' });
      return;
    }

    try {
      const result = await pool.query(
        `SELECT stripe_session_id FROM checkout_cancellations WHERE cancellation_token = $1`,
        [token],
      );
      const cancellation = result.rows?.[0];
      if (!cancellation) {
        response.status(404).json({ error: 'Session Checkout introuvable.' });
        return;
      }

      const session = await stripe.checkout.sessions.retrieve(cancellation.stripe_session_id);
      if (session.status === 'complete' || session.payment_status === 'paid') {
        response.status(409).json({ error: 'Cette session Checkout a déjà été payée.' });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE checkout_cancellations
           SET notified_at = now()
           WHERE cancellation_token = $1 AND notified_at IS NULL
           RETURNING cancellation_token`,
          [token],
        );
        if (updated.rowCount) {
          const eventId = `local_checkout_cancelled:${token}`;
          const inserted = await client.query(
            `INSERT INTO processed_events (stripe_event_id, event_type)
             VALUES ($1, 'checkout.cancelled')
             ON CONFLICT (stripe_event_id) DO NOTHING
             RETURNING stripe_event_id`,
            [eventId],
          );
          if (inserted.rowCount) {
            await enqueueNotification(client, eventId, buildCheckoutCancellationPayload(session));
          }
        }
        await client.query('COMMIT');
        response.status(202).json({ queued: Boolean(updated.rowCount), duplicate: !updated.rowCount });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Unable to queue Checkout cancellation notification:', error);
      response.status(500).json({ error: 'Impossible de mettre la notification Slack en file.' });
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
        'checkout.session.expired',
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
          let shouldNotify = true;
          if (event.type === 'checkout.session.expired') {
            const session = event.data.object as Stripe.Checkout.Session;
            const cancellation = await client.query(
              `UPDATE checkout_cancellations
               SET notified_at = now()
               WHERE stripe_session_id = $1 AND notified_at IS NULL
               RETURNING cancellation_token`,
              [session.id],
            );
            const existing = cancellation.rowCount
              ? cancellation
              : await client.query(
                `SELECT cancellation_token FROM checkout_cancellations WHERE stripe_session_id = $1`,
                [session.id],
              );
            shouldNotify = Boolean(cancellation.rowCount) || !existing.rowCount;
          }
          if (shouldNotify) {
            await enqueueNotification(client, event.id, buildSlackPayload(event));
          }
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