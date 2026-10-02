import type Stripe from 'stripe';
import { plans, type PlanId } from './plans';

export type SlackPayload = {
  text: string;
  blocks: Array<Record<string, unknown>>;
};

function euroAmount(amountInCents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountInCents / 100);
}

function eventDetails(event: Stripe.Event): {
  status: string;
  planName: string;
  amount: number;
  currency: string;
  customerId: string;
} {
  const object = event.data.object as unknown as Record<string, any>;
  const planId = (
    object.metadata?.plan
    ?? object.parent?.subscription_details?.metadata?.plan
    ?? object.subscription_details?.metadata?.plan
  ) as PlanId | undefined;
  const invoiceDescription = object.lines?.data?.find((line: any) => line.description)?.description;
  const describedPlan = typeof invoiceDescription === 'string'
    ? invoiceDescription.match(/^Abonnement (Starter|Pro)$/)?.[1]
    : undefined;
  const planName = planId && plans[planId]
    ? plans[planId].name
    : describedPlan ?? 'Plan inconnu';
  const customerId = typeof object.customer === 'string'
    ? object.customer
    : object.customer?.id ?? 'indisponible';

  if (event.type === 'invoice.payment_succeeded') {
    return {
      status: 'Paiement recu',
      planName,
      amount: object.amount_paid ?? 0,
      currency: object.currency ?? 'eur',
      customerId,
    };
  }

  if (event.type === 'customer.subscription.deleted') {
    const price = object.items?.data?.[0]?.price;
    return {
      status: 'Abonnement resilie',
      planName,
      amount: price?.unit_amount ?? 0,
      currency: price?.currency ?? 'eur',
      customerId,
    };
  }

  if (event.type === 'checkout.session.expired') {
    return {
      status: 'Checkout expiré',
      planName,
      amount: object.amount_total ?? (planId ? plans[planId].amount : 0),
      currency: object.currency ?? 'eur',
      customerId,
    };
  }

  return {
    status: 'Checkout termine',
    planName,
    amount: object.amount_total ?? (planId ? plans[planId].amount : 0),
    currency: object.currency ?? 'eur',
    customerId,
  };
}

function formatSlackPayload(
  detail: ReturnType<typeof eventDetails>,
  eventId: string,
  eventType: string,
): SlackPayload {
  const amount = euroAmount(detail.amount, detail.currency);
  return {
    text: `${detail.status} | ${detail.planName} | ${amount}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Facturation SaaS · ${detail.status}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Statut*\n${detail.status}` },
          { type: 'mrkdwn', text: `*Plan*\n${detail.planName}` },
          { type: 'mrkdwn', text: `*Montant*\n${amount}` },
          { type: 'mrkdwn', text: `*Client*\n\`${detail.customerId}\`` },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Événement: \`${eventId}\` · \`${eventType}\`` },
        ],
      },
    ],
  };
}

export function buildSlackPayload(event: Stripe.Event): SlackPayload {
  return formatSlackPayload(eventDetails(event), event.id, event.type);
}

export function buildCheckoutCancellationPayload(session: Stripe.Checkout.Session): SlackPayload {
  const planId = session.metadata?.plan as PlanId | undefined;
  const planName = planId && plans[planId] ? plans[planId].name : 'Plan inconnu';
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? 'indisponible';

  return formatSlackPayload({
    status: 'Checkout abandonné',
    planName,
    amount: session.amount_total ?? (planId ? plans[planId].amount : 0),
    currency: session.currency ?? 'eur',
    customerId,
  }, session.id, 'retour client depuis Checkout');
}

export async function postSlackMessage(webhookUrl: string, payload: SlackPayload): Promise<void> {
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not configured');
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Slack webhook responded with HTTP ${response.status}`);
}