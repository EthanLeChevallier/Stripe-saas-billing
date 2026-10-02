import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { buildSlackPayload } from './slack';

describe('Slack Block Kit payload', () => {
  it('reads subscription plan metadata from an invoice and formats euros', () => {
    const event = {
      id: 'evt_invoice',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          amount_paid: 3000,
          currency: 'eur',
          customer: 'cus_test',
          parent: { subscription_details: { metadata: { plan: 'pro' } } },
        },
      },
    } as unknown as Stripe.Event;

    const payload = buildSlackPayload(event);

    expect(payload.text).toContain('Pro');
    expect(payload.text).toContain('30,00');
    expect(payload.blocks[1]).toMatchObject({
      type: 'section',
      fields: expect.arrayContaining([
        { type: 'mrkdwn', text: '*Plan*\nPro' },
        { type: 'mrkdwn', text: '*Client*\n`cus_test`' },
      ]),
    });
  });
});