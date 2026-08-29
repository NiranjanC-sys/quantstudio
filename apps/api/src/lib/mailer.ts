/**
 * Outbound transactional mail.
 *
 * The gateway never talks to an SMTP server on a request path — a slow mail
 * provider must not become a slow signup. `queue` hands the message to BullMQ;
 * `console` prints it, which is what local development and the integration
 * suite use.
 */
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Template name resolved by the mail worker; bodies are not built here. */
  template: 'magic-link' | 'invite' | 'receipt' | 'contest-result' | 'password-changed';
  variables: Record<string, string>;
}

export interface Mailer {
  send(message: OutboundEmail): Promise<void>;
}

export function createMailer(
  env: Env,
  logger: FastifyBaseLogger,
  queue: Queue<OutboundEmail> | null,
): Mailer {
  if (env.EMAIL_TRANSPORT === 'queue') {
    if (!queue) {
      throw new Error('EMAIL_TRANSPORT=queue requires the email queue to be constructed.');
    }
    return {
      async send(message) {
        await queue.add(message.template, message, {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        });
      },
    };
  }

  return {
    async send(message) {
      // §11 forbids PII in logs, so the recipient is not logged; the variables
      // are, because in development they contain the link the developer needs.
      logger.info(
        { template: message.template, subject: message.subject, variables: message.variables },
        'email dispatched (console transport)',
      );
    },
  };
}
