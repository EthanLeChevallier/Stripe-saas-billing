import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { createApp } from './app';

function dependencies() {
  const stripe = {
    checkout: {
      sessions: {
        create: vi.fn(),
        list: vi.fn().mockResolvedValue({ data: [] }),
        retrieve: vi.fn(),
      },
    },
    invoices: { list: vi.fn().mockResolvedValue({ data: [] }) },
    subscriptions: { list: vi.fn().mockResolvedValue({ data: [] }) },
    customers: { list: vi.fn().mockResolvedValue({ data: [] }) },
    webhooks: { constructEvent: vi.fn() },
  } as unknown as Stripe;
  const pool = {
    connect: vi.fn(async () => ({
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ stripe_event_id: 'evt_test' }] })
        .mockResolvedValue({}),
      release: vi.fn(),
    })),
    query: vi.fn().mockResolvedValue({}),
  } as any;
  return { stripe, pool };
}

afterEach(() => vi.restoreAllMocks());

describe('checkout and Stripe webhook routes', () => {
  it('returns health information for the local service', async () => {
    const { stripe, pool } = dependencies();
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, service: 'stripe-saas-billing' });
  });

  it('returns dashboard summary for the local SaaS demo', async () => {
    const { stripe, pool } = dependencies();
    pool.query
      .mockResolvedValueOnce({ rows: [{ processed_events: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ checkout_abandonments: 1 }] });
    const nowDate = new Date();
    const now = Math.floor(nowDate.getTime() / 1000);
    const priorOctober = Math.floor(new Date(nowDate.getFullYear() - 1, nowDate.getMonth(), 5).getTime() / 1000);
    vi.mocked(stripe.invoices.list)
      .mockResolvedValueOnce({
        data: [{
          id: 'in_paid',
          created: now,
          paid: true,
          status: 'paid',
          amount_paid: 3000,
          currency: 'eur',
          customer: 'cus_test',
          lines: { data: [{ description: 'Abonnement Pro' }] },
        }],
        has_more: true,
      } as unknown as Stripe.ApiList<Stripe.Invoice>)
      .mockResolvedValueOnce({
        data: [{
          id: 'in_prior_october',
          created: priorOctober,
          paid: true,
          status: 'paid',
          amount_paid: 1000,
          currency: 'eur',
          customer: 'cus_prior',
          lines: { data: [{ description: 'Abonnement Starter' }] },
        }],
        has_more: false,
      } as unknown as Stripe.ApiList<Stripe.Invoice>);
    vi.mocked(stripe.subscriptions.list).mockResolvedValue({
      data: [
        { id: 'sub_active', status: 'active' },
        { id: 'sub_canceled', status: 'canceled', canceled_at: now },
        { id: 'sub_cancel_scheduled', status: 'active', canceled_at: now, cancel_at_period_end: true },
      ],
      has_more: false,
    } as unknown as Stripe.ApiList<Stripe.Subscription>);
    vi.mocked(stripe.checkout.sessions.list).mockResolvedValue({
      data: [{ id: 'cs_complete', status: 'complete', payment_status: 'paid' }],
      has_more: false,
    } as unknown as Stripe.ApiList<Stripe.Checkout.Session>);
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).get('/api/v1/dashboard');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      source: expect.stringContaining('Stripe API'),
      summary: {
        processedEvents: expect.any(Number),
        successfulPayments: 2,
        activeSubscriptions: 2,
      },
      revenueTrend: expect.arrayContaining([expect.objectContaining({ value: 30 })]),
      teamHealth: expect.any(Array),
      recentPayments: expect.any(Array),
    });
    expect(response.body.revenueTrend).toHaveLength(13);
    expect(response.body.revenueTrend[0].value).toBe(10);
    expect(response.body.revenueTrend.at(-1).value).toBe(30);
    expect(response.body.conversionFunnel.at(-1)).toMatchObject({ label: 'Checkouts abandonnés', value: 1 });
    expect(stripe.invoices.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, created: expect.any(Object) }));
    expect(stripe.invoices.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ starting_after: 'in_paid' }));
  });

  it('rejects an unknown checkout plan before calling Stripe', async () => {
    const { stripe, pool } = dependencies();
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).post('/api/v1/checkout/sessions').send({ plan: 'enterprise' });
    expect(response.status).toBe(400);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('stores a cancellation token in the Checkout return URL', async () => {
    const { stripe, pool } = dependencies();
    vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
      id: 'cs_test',
      url: 'https://checkout.stripe.test/session',
    } as Stripe.Response<Stripe.Checkout.Session>);
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).post('/api/v1/checkout/sessions').send({ plan: 'pro' });

    expect(response.status).toBe(201);
    const createParams = vi.mocked(stripe.checkout.sessions.create).mock.calls[0][0];
    const cancelUrl = new URL(createParams.cancel_url!);
    const token = cancelUrl.searchParams.get('cancel_token');
    expect(cancelUrl.searchParams.get('checkout')).toBe('cancelled');
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO checkout_cancellations'),
      [token, 'cs_test', 'pro'],
    );
  });

  it('queues one Slack notification when the customer returns from unpaid Checkout', async () => {
    const { stripe, pool } = dependencies();
    const token = '4a90d407-975c-4ea7-9715-26a254000001';
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ cancellation_token: token }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ stripe_event_id: `local_checkout_cancelled:${token}` }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    pool.query.mockResolvedValueOnce({ rows: [{ stripe_session_id: 'cs_test', plan_id: 'pro' }] });
    pool.connect.mockResolvedValueOnce(client as any);
    vi.mocked(stripe.checkout.sessions.retrieve).mockResolvedValue({
      id: 'cs_test',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: 3000,
      currency: 'eur',
      customer: 'cus_test',
      metadata: { plan: 'pro' },
    } as Stripe.Response<Stripe.Checkout.Session>);
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).post('/api/v1/checkout/cancellations').send({ token });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ queued: true, duplicate: false });
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test');
    expect(client.query.mock.calls.some(([query]) => String(query).includes('INSERT INTO notification_outbox'))).toBe(true);
  });

  it('queues Slack for a Stripe Checkout expiration webhook', async () => {
    const { stripe, pool } = dependencies();
    const event = {
      id: 'evt_expired',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_expired', metadata: { plan: 'starter' }, amount_total: 1000, currency: 'eur' } },
    } as unknown as Stripe.Event;
    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue(event);
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{"id":"evt_expired"}');

    expect(response.status).toBe(200);
    const client = await pool.connect.mock.results[0].value;
    const queries = client.query.mock.calls.map(([query]: [string]) => String(query));
    expect(queries.some((query: string) => query.includes('UPDATE checkout_cancellations'))).toBe(true);
    expect(queries.some((query: string) => query.includes('INSERT INTO notification_outbox'))).toBe(true);
  });

  it('rejects an invalid signature without touching the database', async () => {
    const { stripe, pool } = dependencies();
    vi.mocked(stripe.webhooks.constructEvent).mockImplementation(() => { throw new Error('signature mismatch'); });
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('stripe-signature', 'invalid')
      .set('content-type', 'application/json')
      .send('{"id":"evt_test"}');
    expect(response.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('persists a verified supported event and its Slack message transactionally', async () => {
    const { stripe, pool } = dependencies();
    const event = {
      id: 'evt_test',
      type: 'checkout.session.completed',
      data: { object: { metadata: { plan: 'starter' }, amount_total: 1000, currency: 'eur', customer: 'cus_test' } },
    } as unknown as Stripe.Event;
    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue(event);
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });

    const response = await request(app)
      .post('/api/v1/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{"id":"evt_test"}');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: false });
    expect(pool.connect).toHaveBeenCalledOnce();
    const client = await pool.connect.mock.results[0].value;
    const queries = client.query.mock.calls.map(([query]: [string]) => query);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('INSERT INTO processed_events');
    expect(queries[2]).toContain('INSERT INTO notification_outbox');
    expect(queries[3]).toBe('COMMIT');
    expect(pool.query).not.toHaveBeenCalled();
  });
});