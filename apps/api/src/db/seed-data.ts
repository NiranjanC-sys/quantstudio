/**
 * Seed content, derived from the one catalogue.
 *
 * This file used to transcribe the syllabus by hand, which is how the project
 * ended up with three disagreeing lesson counts. It now derives everything from
 * `@redquant/content`, so the database, the web app and the curriculum page
 * cannot drift apart: there is one catalogue and one set of numbers.
 *
 * PLANS and ROADMAPS below remain local, because they are commercial and
 * pedagogical configuration rather than curriculum.
 */

import { LESSONS, MODULES, TRACKS, type Lesson } from '@redquant/content';

export interface LessonSeed {
  /** Catalogue id, e.g. `t1.m3.l2`. The stable key across every system. */
  id: string;
  title: string;
  kind: Lesson['type'];
  minutes: number;
}

export interface ModuleSeed {
  /** Catalogue id, lower case, e.g. `t0.m1`. */
  id: string;
  /** Database code. `catalog.modules` constrains this to `^T[0-9][A-D]?[.]M[0-9]+$`. */
  code: string;
  title: string;
  summary: string;
  lessons: readonly LessonSeed[];
}

export interface TrackSeed {
  code: string;
  title: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  summary: string;
  modules: readonly ModuleSeed[];
}

/**
 * The syllabus, projected out of the catalogue in track and module order.
 *
 * Checkpoints are not synthesised here: the catalogue already carries real
 * checkpoint, lab, drill and project nodes with their own durations, and
 * inventing extra ones was what pushed the seeded total to 353 against the
 * catalogue's own count.
 */
export const SYLLABUS: readonly TrackSeed[] = TRACKS.map((track) => ({
  code: track.code,
  title: track.title,
  level: track.level[0] ?? 'L1',
  summary: track.summary,
  modules: MODULES.filter((m) => m.track === track.id)
    .sort((a, b) => a.order - b.order)
    .map((module) => ({
      id: module.id,
      code: module.id.toUpperCase(),
      title: module.title,
      summary: module.summary,
      lessons: LESSONS.filter((l) => l.module === module.id).map((l) => ({
        id: l.id,
        title: l.title,
        kind: l.type,
        minutes: l.minutes,
      })),
    })),
}));

/** Totals, so a caller can assert the seed matches the catalogue. */
export const SYLLABUS_COUNTS = {
  tracks: SYLLABUS.length,
  modules: SYLLABUS.reduce((n, t) => n + t.modules.length, 0),
  lessons: SYLLABUS.reduce((n, t) => n + t.modules.reduce((m, mod) => m + mod.lessons.length, 0), 0),
} as const;

export interface RoadmapSeed {
  slug: string;
  title: string;
  persona: string;
  durationWeeks: number;
  path: readonly string[];
}

function range(track: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`${track}.M${i}`);
  return out;
}

export const ROADMAPS: readonly RoadmapSeed[] = [
  {
    slug: 'cs-student',
    title: 'CS student',
    persona: 'Computer-science undergraduate with discrete maths and algorithms',
    durationWeeks: 14,
    path: [...range('T0', 2, 6), ...range('T1', 1, 12), ...range('T2', 1, 10), ...range('T3', 1, 3), 'T7.M2'],
  },
  {
    slug: 'physics-student',
    title: 'Physics student',
    persona: 'Physics undergraduate comfortable with linear algebra and Dirac notation',
    durationWeeks: 12,
    path: [...range('T0', 6, 7), ...range('T1', 1, 12), ...range('T4', 1, 8), 'T5A.M1', ...range('T6', 1, 7)],
  },
  {
    slug: 'software-engineer-to-quantum-sde',
    title: 'Software engineer to quantum SDE',
    persona: 'Working software engineer moving into quantum tooling',
    durationWeeks: 16,
    path: [...range('T0', 1, 8), ...range('T1', 1, 12), ...range('T3', 1, 9), ...range('T2', 1, 5), ...range('T7', 2, 4)],
  },
  {
    slug: 'data-scientist-to-qml',
    title: 'Data scientist to QML',
    persona: 'Data scientist with classical ML experience',
    durationWeeks: 9,
    path: [...range('T0', 2, 5), ...range('T1', 1, 9), 'T5C.M1', ...range('T3', 6, 8)],
  },
  {
    slug: 'researcher',
    title: 'Researcher',
    persona: 'Graduate researcher entering quantum information',
    durationWeeks: 20,
    path: ['T0.M8', ...range('T2', 1, 10), ...range('T4', 1, 8), 'T5A.M1', 'T7.M1', 'T7.M6'],
  },
  {
    slug: 'security-engineer-to-pqc',
    title: 'Security engineer to PQC',
    persona: 'Security engineer planning a post-quantum migration',
    durationWeeks: 7,
    path: [...range('T0', 1, 2), ...range('T1', 1, 7), 'T2.M2', 'T2.M5', 'T5D.M1'],
  },
  {
    slug: 'technical-manager',
    title: 'Technical manager',
    persona: 'Engineering manager who needs the shape, not the derivations',
    durationWeeks: 4,
    path: [...range('T1', 1, 5), 'T3.M4', 'T6.M5', 'T5B.M1'],
  },
];

/**
 * The §7 plan matrix as billable rows. `entitlementsFor()` in
 * `src/entitlements` is the runtime authority; these rows exist so the pricing
 * page and Stripe have something to read, and so `billing.subscriptions` has a
 * foreign key to point at.
 */
export interface PlanSeed {
  code: 'free' | 'pro' | 'teams' | 'campus';
  name: string;
  priceCents: number;
  interval: 'month' | 'year' | 'none';
  seatBased: boolean;
  position: number;
  features: Record<string, unknown>;
}

export const PLANS: readonly PlanSeed[] = [
  {
    code: 'free',
    name: 'Free',
    priceCents: 0,
    interval: 'none',
    seatBased: false,
    position: 1,
    features: {
      lessons: 'T0-T1',
      labsPerMonth: 40,
      maxQubits: 16,
      noisySimulation: false,
      simCreditsPerMonth: 500,
      tutorMessagesPerDay: 15,
      contests: 'participate',
      interviewQuestions: 20,
      instructorDashboard: false,
      sso: ['google', 'github'],
      certificates: false,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceCents: 1_900,
    interval: 'month',
    seatBased: false,
    position: 2,
    features: {
      lessons: 'all',
      labsPerMonth: null,
      maxQubits: 28,
      noisySimulation: 12,
      simCreditsPerMonth: 20_000,
      tutorMessagesPerDay: 300,
      contests: 'participate + rated + editorials',
      interviewQuestions: null,
      instructorDashboard: false,
      sso: ['google', 'github', 'microsoft', 'orcid', 'linkedin'],
      certificates: true,
    },
  },
  {
    code: 'teams',
    name: 'Teams',
    priceCents: 3_900,
    interval: 'month',
    seatBased: true,
    position: 3,
    features: {
      lessons: 'all',
      labsPerMonth: null,
      maxQubits: 30,
      noisySimulation: 14,
      simCreditsPerMonth: 50_000,
      simCreditsPerSeat: true,
      tutorMessagesPerDay: 300,
      contests: '+ private contests',
      interviewQuestions: null,
      instructorDashboard: true,
      sso: ['google', 'github', 'microsoft', 'orcid', 'linkedin', 'saml'],
      certificates: true,
    },
  },
  {
    code: 'campus',
    name: 'Campus',
    // Negotiated per contract (§7), so the list price is zero and the real
    // figure lives on the subscription.
    priceCents: 0,
    interval: 'year',
    seatBased: true,
    position: 4,
    features: {
      lessons: 'all',
      labsPerMonth: null,
      maxQubits: 32,
      noisySimulation: 14,
      simCreditsPerMonth: 'negotiated',
      tutorMessagesPerDay: 300,
      contests: '+ private contests',
      interviewQuestions: null,
      instructorDashboard: true,
      sso: ['google', 'github', 'microsoft', 'orcid', 'linkedin', 'saml'],
      scim: true,
      certificates: 'co-branded',
    },
  },
];
