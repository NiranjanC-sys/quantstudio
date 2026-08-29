/**
 * BullMQ producers (system-design §6 step 1, §9).
 *
 * The gateway only ever *enqueues*. Grading, finalisation and reconciliation run
 * in workers, because §3 says the API gateway never does heavy compute.
 */
import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../env.js';
import type { OutboundEmail } from '../lib/mailer.js';
import {
  JOB_PRIORITY,
  QUEUE_NAMES,
  type BillingJob,
  type ContestJob,
  type GradeContestJob,
  type GradeJob,
  type GradeLabJob,
  type MaintenanceJob,
} from './types.js';

export * from './types.js';

export interface Queues {
  grade: Queue<GradeJob>;
  email: Queue<OutboundEmail>;
  contest: Queue<ContestJob>;
  billing: Queue<BillingJob>;
  maintenance: Queue<MaintenanceJob>;
  /** Enqueues a lab submission. Call inside the submission transaction. */
  enqueueLab(job: GradeLabJob, jobId: string): Promise<string>;
  /** Enqueues a contest submission at contest priority. */
  enqueueContest(job: GradeContestJob, jobId: string): Promise<string>;
  scheduleContestFinalise(contestId: string, runAt: Date): Promise<void>;
  scheduleContestFreeze(contestId: string, runAt: Date): Promise<void>;
  /** Registers the nightly Stripe reconciliation and partition roll-forward. */
  installRepeatables(): Promise<void>;
  depth(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 10_000 },
  removeOnFail: { age: 86_400 },
};

export function createQueues(env: Env, connection: Redis): Queues {
  const shared = { connection, prefix: `${env.REDIS_KEY_PREFIX}bull` };

  const grade = new Queue<GradeJob>(QUEUE_NAMES.grade, shared);
  const email = new Queue<OutboundEmail>(QUEUE_NAMES.email, shared);
  const contest = new Queue<ContestJob>(QUEUE_NAMES.contest, shared);
  const billing = new Queue<BillingJob>(QUEUE_NAMES.billing, shared);
  const maintenance = new Queue<MaintenanceJob>(QUEUE_NAMES.maintenance, shared);
  const queues = [grade, email, contest, billing, maintenance];

  return {
    grade,
    email,
    contest,
    billing,
    maintenance,

    async enqueueLab(job, jobId) {
      // `jobId` is the submission id: BullMQ deduplicates on it, so a retried
      // HTTP request that reuses the same submission cannot double-grade.
      const added = await grade.add('lab', job, {
        ...DEFAULT_JOB_OPTIONS,
        jobId,
        priority: JOB_PRIORITY.lab,
      });
      return added.id ?? jobId;
    },

    async enqueueContest(job, jobId) {
      const added = await grade.add('contest', job, {
        ...DEFAULT_JOB_OPTIONS,
        jobId,
        priority: JOB_PRIORITY.contest,
        // A contest submission that cannot be graded is a correctness incident,
        // so it is retried harder and kept for the post-contest replay.
        attempts: 10,
        removeOnFail: false,
      });
      return added.id ?? jobId;
    },

    async scheduleContestFinalise(contestId, runAt) {
      const delay = Math.max(0, runAt.getTime() - Date.now());
      await contest.add(
        'finalise',
        { kind: 'finalise', contestId },
        { ...DEFAULT_JOB_OPTIONS, jobId: `finalise:${contestId}`, delay, attempts: 20 },
      );
    },

    async scheduleContestFreeze(contestId, runAt) {
      const delay = Math.max(0, runAt.getTime() - Date.now());
      await contest.add(
        'freeze',
        { kind: 'freeze', contestId },
        { ...DEFAULT_JOB_OPTIONS, jobId: `freeze:${contestId}`, delay, attempts: 20 },
      );
    },

    async installRepeatables() {
      // §7: "reconciled by a nightly job that replays Stripe state".
      await billing.add(
        'reconcile',
        { kind: 'reconcile', runDate: new Date().toISOString().slice(0, 10) },
        { ...DEFAULT_JOB_OPTIONS, repeat: { pattern: '17 3 * * *', tz: 'UTC' }, jobId: 'nightly-reconcile' },
      );
      await billing.add(
        'credit-rollover',
        { kind: 'credit-rollover', runDate: new Date().toISOString().slice(0, 10) },
        { ...DEFAULT_JOB_OPTIONS, repeat: { pattern: '11 0 * * *', tz: 'UTC' }, jobId: 'credit-rollover' },
      );
      // §5: partitions must exist before the writes that need them.
      await maintenance.add(
        'partitions',
        { kind: 'partitions', monthsAhead: 3, weeksAhead: 6 },
        { ...DEFAULT_JOB_OPTIONS, repeat: { pattern: '5 * * * *', tz: 'UTC' }, jobId: 'partitions' },
      );
    },

    async depth() {
      const entries = await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
          return [queue.name, (counts['waiting'] ?? 0) + (counts['active'] ?? 0)] as const;
        }),
      );
      return Object.fromEntries(entries);
    },

    async close() {
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}

/** Used by the health endpoint to report grader lag without owning a worker. */
export function createQueueEvents(env: Env, connection: Redis): QueueEvents {
  return new QueueEvents(QUEUE_NAMES.grade, {
    connection,
    prefix: `${env.REDIS_KEY_PREFIX}bull`,
  });
}
