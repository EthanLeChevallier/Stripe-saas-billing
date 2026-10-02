export const plans = {
  starter: { name: 'Starter', amount: 1000, currency: 'eur' },
  pro: { name: 'Pro', amount: 3000, currency: 'eur' },
} as const;

export type PlanId = keyof typeof plans;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && Object.hasOwn(plans, value);
}