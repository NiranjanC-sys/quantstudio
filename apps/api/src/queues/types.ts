/**
 * Job payloads. These are the contract between the gateway (producer) and the
 * grader / maintenance workers (consumers), so they live apart from either.
 */
import type { BackendKind } from '../entitlements/credits.js';

export const QUEUE_NAMES = {
  grade: 'grade',
  email: 'email',
  contest: 'contest-ops',
  billing: 'billing-ops',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * §6 gives contest submissions priority over lab submissions on the shared
 * `grade` queue. BullMQ treats a *lower* number as higher priority.
 */
export const JOB_PRIORITY = {
  contest: 1,
  lab: 5,
  practice: 9,
} as const;

export interface GradeLabJob {
  kind: 'lab';
  submissionId: string;
  submissionCreatedAt: string;
  userId: string;
  lessonId: number;
  graderKey: string;
  language: string;
  source: string;
  /** Credits already debited for this job; refunded if the kernel never ran it. */
  creditsCharged: number;
}

export interface GradeContestJob {
  kind: 'contest';
  submissionId: string;
  submissionCreatedAt: string;
  userId: string;
  contestId: string;
  problemId: string;
  graderKey: string;
  language: string;
  source: string;
  points: number;
  elapsedSeconds: number;
  penaltySecondsPerReject: number;
  isVirtual: boolean;
  /** Seconds until the contest's Redis keys may expire. */
  keyTtlSeconds: number;
}

export type GradeJob = GradeLabJob | GradeContestJob;

export interface ContestFinaliseJob {
  kind: 'finalise';
  contestId: string;
}

export interface ContestFreezeJob {
  kind: 'freeze';
  contestId: string;
}

export type ContestJob = ContestFinaliseJob | ContestFreezeJob;

export interface BillingReconcileJob {
  kind: 'reconcile';
  /** ISO date of the night this run covers. */
  runDate: string;
}

export interface CreditPeriodRolloverJob {
  kind: 'credit-rollover';
  runDate: string;
}

export type BillingJob = BillingReconcileJob | CreditPeriodRolloverJob;

export interface PartitionMaintenanceJob {
  kind: 'partitions';
  monthsAhead: number;
  weeksAhead: number;
}

export type MaintenanceJob = PartitionMaintenanceJob;

export interface KernelSimulationRequest {
  circuitIr: unknown;
  backend: BackendKind;
  shots: number;
  qubits: number;
  noiseModel: string | null;
  seed: number | null;
}
