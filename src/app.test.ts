import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Stripe from 'stripe';
import { createApp } from './app';

function dependencies() {
  const stripe = {
    checkout: { sessions: { create: vi.fn(), list: vi.fn().mockResolvedValue({ data: [] }) } },
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
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).get('/api/v1/dashboard');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      source: expect.stringContaining('Stripe API'),
      summary: {
        processedEvents: expect.any(Number),
        activeSubscriptions: expect.any(Number),
      },
      revenueTrend: expect.any(Array),
      teamHealth: expect.any(Array),
      recentPayments: expect.any(Array),
    });
  });

  it('rejects an unknown checkout plan before calling Stripe', async () => {
    const { stripe, pool } = dependencies();
    const app = createApp({ stripe, pool, webhookSecret: 'whsec_test', appBaseUrl: 'http://localhost:3000' });
    const response = await request(app).post('/api/v1/checkout/sessions').send({ plan: 'enterprise' });
    expect(response.status).toBe(400);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
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