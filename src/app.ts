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

  app.get('/api/v1/dashboard', (_request: Request, response: Response) => {
    response.status(200).json({
      summary: {
        monthlyRevenue: 4000,
        activeSubscriptions: 42,
        churn: 2.4,
        conversionRate: 7.8,
        retentionRate: 94.2,
        netRevenue: 3450,
        forecastRevenue: 5400,
        newCustomers: 18,
      },
      revenueTrend: [
        { month: 'Jan', value: 2100 },
        { month: 'Fév', value: 2500 },
        { month: 'Mar', value: 2700 },
        { month: 'Avr', value: 3000 },
        { month: 'Mai', value: 3600 },
        { month: 'Jui', value: 4000 },
      ],
      teamHealth: [
        { name: 'Support', score: 94, detail: 'Temps de réponse < 2h' },
        { name: 'Paiements', score: 96, detail: 'Webhook Stripe stable' },
        { name: 'Product', score: 88, detail: '2 idées en validation' },
      ],
      conversionFunnel: [
        { label: 'Visiteurs', value: 2120 },
        { label: 'Candidats', value: 630 },
        { label: 'Essai', value: 168 },
        { label: 'Payants', value: 42 },
      ],
      marketing: {
        headline: 'Le SaaS qui fait gagner du temps à vos équipes et de la confiance à vos clients.',
        subhead: 'Centralisez facturation, onboarding et engagement dans une expérience premium pensée pour la croissance.',
        stats: [
          { label: 'Temps gagné', value: '4h/semaine' },
          { label: 'Nouveaux clients', value: '+18' },
          { label: 'Satisfaction', value: '4.9/5' },
        ],
      },
      recentPayments: [
        { id: 'pay_1001', plan: 'Pro', amount: 3000, customer: 'cus_01', status: 'paid', date: '2026-10-02T15:30:00.000Z' },
        { id: 'pay_1002', plan: 'Starter', amount: 1000, customer: 'cus_02', status: 'paid', date: '2026-10-02T14:42:00.000Z' },
        { id: 'pay_1003', plan: 'Pro', amount: 3000, customer: 'cus_03', status: 'pending', date: '2026-10-02T13:20:00.000Z' },
        { id: 'pay_1004', plan: 'Starter', amount: 1000, customer: 'cus_04', status: 'paid', date: '2026-10-02T12:10:00.000Z' },
      ],
      alerts: [
        'Webhook Stripe surveillé en continu',
        '2 abonnements à relancer cette semaine',
        'Taux de conversion en hausse de 12%',
      ],
    });
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