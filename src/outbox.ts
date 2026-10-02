import type { Pool, PoolClient } from 'pg';
import type { SlackPayload } from './slack';

export async function enqueueNotification(
  client: PoolClient,
  eventId: string,
  payload: SlackPayload,
): Promise<void> {
  await client.query(
    `INSERT INTO notification_outbox (stripe_event_id, payload)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (stripe_event_id) DO NOTHING`,
    [eventId, JSON.stringify(payload)],
  );
}

export function startOutboxWorker(
  pool: Pool,
  webhookUrl: string,
  pollIntervalMs: number,
  deliver: (url: string, payload: SlackPayload) => Promise<void>,
): () => void {
  let stopped = false;
  let active = false;

  const processOne = async (): Promise<boolean> => {
    const client = await pool.connect();
    let row: { id: number; payload: SlackPayload; attempts: number } | undefined;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT id, payload, attempts
         FROM notification_outbox
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_until < now())
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        `UPDATE notification_outbox
         SET status = 'processing', locked_until = now() + interval '1 minute', attempts = attempts + 1
         WHERE id = $1`,
        [row.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const attempt = row.attempts + 1;
    try {
      await deliver(webhookUrl, row.payload);
      await pool.query(
        `UPDATE notification_outbox
         SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL
         WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      const delaySeconds = Math.min(60 * 2 ** Math.min(attempt - 1, 10), 86_400);
      await pool.query(
        `UPDATE notification_outbox
         SET status = CASE WHEN attempts >= 12 THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + ($2 * interval '1 second'),
             locked_until = NULL, last_error = $3
         WHERE id = $1`,
        [row.id, delaySeconds, error instanceof Error ? error.message.slice(0, 1000) : 'Unknown error'],
      );
    }
    return true;
  };

  const poll = async (): Promise<void> => {
    if (stopped || active) return;
    active = true;
    try {
      while (!stopped && await processOne()) {
        // Drain ready messages before waiting for the next poll interval.
      }
    } catch (error) {
      console.error('Outbox worker error:', error);
    } finally {
      active = false;
    }
  };

  const timer = setInterval(() => void poll(), pollIntervalMs);
  void poll();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}