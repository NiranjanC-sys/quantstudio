/**
 * Idempotent seed.
 *
 * Inserts the eight tracks and their modules and lessons from the syllabus, the
 * lesson prerequisite DAG derived from that ordering, a concept per module with
 * its own DAG, the roadmaps, the four plan rows from system-design §7, and a
 * demo organisation with an instructor, a cohort, students and an assignment so
 * the instructor dashboard has something to show on a fresh database.
 *
 * Every statement is `on conflict do nothing`/`do update`, so running it twice
 * is a no-op rather than a duplicate-key failure. That matters: it runs in CI,
 * in the integration suite and on a developer's machine, often against a
 * database that already has some of it.
 *
 * Usage: `pnpm --filter @redquant/api db:seed`
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createPasswordHasher } from '../auth/password.js';
import { loadEnv, type Env } from '../env.js';
import * as schema from './schema/index.js';
import {
  companies,
  conceptEdges,
  concepts,
  lessonConcepts,
  lessonPrereqs,
  lessons,
  modules,
  questions,
  roadmaps,
  tracks,
} from './schema/catalog.js';
import { orgMembers, orgs, users } from './schema/identity.js';
import { plans, subscriptions } from './schema/billing.js';
import { assignments, cohortMembers, cohorts } from './schema/instructor.js';
import { PLANS, ROADMAPS, SYLLABUS } from './seed-data.js';
import { createEntitlementService } from '../entitlements/service.js';
import type { DatabaseHandles } from './client.js';

type Db = NodePgDatabase<typeof schema>;

/** Six lesson kinds (syllabus). The kind decides grading, XP and gating. */
function lessonKindFor(title: string, isLast: boolean): {
  kind: 'concept' | 'interactive' | 'lab' | 'drill' | 'checkpoint' | 'project';
  minutes: number;
  xp: number;
} {
  const lowered = title.toLowerCase();
  if (lowered.startsWith('project')) return { kind: 'project', minutes: 240, xp: 200 };
  if (lowered.startsWith('diagnostic') || lowered.includes('checkpoint')) {
    return { kind: 'checkpoint', minutes: 15, xp: 40 };
  }
  if (lowered.includes(' lab') || lowered.includes('hands-on') || lowered.includes('end to end')) {
    return { kind: 'lab', minutes: 25, xp: 60 };
  }
  if (
    lowered.includes('sphere') ||
    lowered.includes('geometric') ||
    lowered.includes('landscape') ||
    lowered.includes('observed') ||
    lowered.includes('seen on')
  ) {
    return { kind: 'interactive', minutes: 8, xp: 20 };
  }
  // The closing lesson of a module is where the drill sits, so the module ends
  // with recall rather than with more reading.
  if (isLast) return { kind: 'drill', minutes: 3, xp: 10 };
  return { kind: 'concept', minutes: 12, xp: 15 };
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export interface SeedSummary {
  tracks: number;
  modules: number;
  lessons: number;
  prereqEdges: number;
  concepts: number;
  conceptEdges: number;
  roadmaps: number;
  plans: number;
  demoUsers: number;
}

/* eslint-disable no-await-in-loop -- the seed is deliberately sequential. */
export async function seed(db: Db, env: Env): Promise<SeedSummary> {
  const summary: SeedSummary = {
    tracks: 0,
    modules: 0,
    lessons: 0,
    prereqEdges: 0,
    concepts: 0,
    conceptEdges: 0,
    roadmaps: 0,
    plans: 0,
    demoUsers: 0,
  };

  // ------------------------------------------------------------------ plans
  const stripePrices: Record<string, string | undefined> = {
    pro: env.STRIPE_PRICE_PRO,
    teams: env.STRIPE_PRICE_TEAMS,
    campus: env.STRIPE_PRICE_CAMPUS,
  };

  for (const plan of PLANS) {
    await db
      .insert(plans)
      .values({
        code: plan.code,
        name: plan.name,
        priceCents: plan.priceCents,
        currency: 'usd',
        interval: plan.interval,
        seatBased: plan.seatBased,
        stripePriceId: stripePrices[plan.code] ?? null,
        features: plan.features,
        position: plan.position,
        active: true,
      })
      .onConflictDoUpdate({
        target: plans.code,
        set: {
          name: plan.name,
          priceCents: plan.priceCents,
          interval: plan.interval,
          seatBased: plan.seatBased,
          stripePriceId: stripePrices[plan.code] ?? null,
          features: plan.features,
          position: plan.position,
        },
      });
    summary.plans += 1;
  }

  // --------------------------------------------------------- tracks/modules
  // §7: "Lessons: T0-T1" on Free, so exactly those two tracks are free-tier.
  const freeTrackCodes = new Set(['T0', 'T1']);

  const trackIdByCode = new Map<string, number>();
  const moduleIdByCode = new Map<string, number>();
  const conceptIdByModule = new Map<string, number>();
  /** Module code -> lesson ids in syllabus order, used to build the DAG. */
  const lessonIdsByModule = new Map<string, number[]>();

  for (const [trackIndex, track] of SYLLABUS.entries()) {
    const lessonCount = track.modules.reduce((sum, module) => sum + module.lessons.length + 1, 0);

    const inserted = await db
      .insert(tracks)
      .values({
        code: track.code,
        slug: slugify(`${track.code} ${track.title}`),
        title: track.title,
        subtitle: null,
        description: null,
        level: track.level,
        position: trackIndex + 1,
        moduleCount: track.modules.length,
        lessonCount,
        freeTier: freeTrackCodes.has(track.code),
      })
      .onConflictDoUpdate({
        target: tracks.code,
        set: {
          title: track.title,
          level: track.level,
          position: trackIndex + 1,
          moduleCount: track.modules.length,
          lessonCount,
          freeTier: freeTrackCodes.has(track.code),
        },
      })
      .returning({ id: tracks.id });

    const trackId = inserted[0]?.id;
    if (trackId === undefined) throw new Error(`Track ${track.code} was not inserted.`);
    trackIdByCode.set(track.code, trackId);
    summary.tracks += 1;

    for (const [moduleIndex, module] of track.modules.entries()) {
      const moduleRow = await db
        .insert(modules)
        .values({
          trackId,
          code: module.code,
          slug: slugify(`${module.code} ${module.title}`),
          title: module.title,
          summary: null,
          level: track.level,
          position: moduleIndex + 1,
          lessonCount: module.lessons.length + 1,
        })
        .onConflictDoUpdate({
          target: modules.code,
          set: {
            trackId,
            title: module.title,
            level: track.level,
            position: moduleIndex + 1,
            lessonCount: module.lessons.length + 1,
          },
        })
        .returning({ id: modules.id });

      const moduleId = moduleRow[0]?.id;
      if (moduleId === undefined) throw new Error(`Module ${module.code} was not inserted.`);
      moduleIdByCode.set(module.code, moduleId);
      summary.modules += 1;

      // One concept per module. Real content would attach several; one is enough
      // for the DAG, the heatmap and the recommender to be exercised, and it is
      // honest about what the seed actually knows.
      const conceptRow = await db
        .insert(concepts)
        .values({
          slug: slugify(`${module.code} ${module.title}`),
          title: module.title,
          description: `Core concept cluster for ${module.code}.`,
          trackId,
        })
        .onConflictDoUpdate({
          target: concepts.slug,
          set: { title: module.title, trackId },
        })
        .returning({ id: concepts.id });

      const conceptId = conceptRow[0]?.id;
      if (conceptId === undefined) throw new Error(`Concept for ${module.code} was not inserted.`);
      conceptIdByModule.set(module.code, conceptId);
      summary.concepts += 1;

      // The syllabus lesson list, plus the checkpoint that gates the next module
      // at 80% ("Checkpoints — gate module progression at 80%").
      const titles = [...module.lessons, `${module.title} Checkpoint`];
      const ids: number[] = [];

      for (const [lessonIndex, title] of titles.entries()) {
        const isCheckpoint = lessonIndex === titles.length - 1;
        const shape = isCheckpoint
          ? ({ kind: 'checkpoint', minutes: 15, xp: 40 } as const)
          : lessonKindFor(title, lessonIndex === titles.length - 2);

        const needsGrader = shape.kind === 'lab' || shape.kind === 'project';
        const slug = slugify(`${module.code} ${title}`);

        const lessonRow = await db
          .insert(lessons)
          .values({
            moduleId,
            slug,
            title,
            kind: shape.kind,
            level: track.level,
            position: lessonIndex + 1,
            estimatedMinutes: shape.minutes,
            xp: shape.xp,
            passThreshold: shape.kind === 'checkpoint' ? 0.8 : 0.6,
            freeTier: freeTrackCodes.has(track.code),
            graderKey: needsGrader ? `${module.code.toLowerCase()}.${lessonIndex + 1}` : null,
            mdxPath: `content/tracks/${track.code.toLowerCase()}/${module.code
              .split('.')[1]
              ?.toLowerCase()}/${slug}.mdx`,
          })
          .onConflictDoUpdate({
            target: lessons.slug,
            set: {
              moduleId,
              title,
              kind: shape.kind,
              position: lessonIndex + 1,
              estimatedMinutes: shape.minutes,
              xp: shape.xp,
              freeTier: freeTrackCodes.has(track.code),
              graderKey: needsGrader ? `${module.code.toLowerCase()}.${lessonIndex + 1}` : null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: lessons.id });

        const lessonId = lessonRow[0]?.id;
        if (lessonId === undefined) throw new Error(`Lesson ${slug} was not inserted.`);
        ids.push(lessonId);
        summary.lessons += 1;

        await db
          .insert(lessonConcepts)
          .values({ lessonId, conceptId, weight: isCheckpoint ? 1 : 0.6 })
          .onConflictDoNothing();
      }

      lessonIdsByModule.set(module.code, ids);
    }
  }

  // ------------------------------------------------------------ the lesson DAG
  //
  // Inside a module every lesson hard-depends on the one before it. Across
  // modules the first lesson depends on the previous module's checkpoint, which
  // is what "checkpoints gate module progression" means structurally. Across
  // tracks the edge is *soft*: the roadmaps deliberately enter tracks out of
  // order, and a hard edge would make that impossible.
  for (const track of SYLLABUS) {
    for (const [moduleIndex, module] of track.modules.entries()) {
      const ids = lessonIdsByModule.get(module.code) ?? [];

      for (let i = 1; i < ids.length; i += 1) {
        await db
          .insert(lessonPrereqs)
          .values({ lessonId: ids[i] as number, prereqLessonId: ids[i - 1] as number, hard: true })
          .onConflictDoNothing();
        summary.prereqEdges += 1;
      }

      const previous = track.modules[moduleIndex - 1];
      if (previous && ids.length > 0) {
        const previousIds = lessonIdsByModule.get(previous.code) ?? [];
        const gate = previousIds[previousIds.length - 1];
        if (gate !== undefined) {
          await db
            .insert(lessonPrereqs)
            .values({ lessonId: ids[0] as number, prereqLessonId: gate, hard: true })
            .onConflictDoNothing();
          summary.prereqEdges += 1;
        }
      }

      // Concept DAG: module N's concept requires module N-1's within a track.
      const conceptId = conceptIdByModule.get(module.code);
      const previousConceptId = previous ? conceptIdByModule.get(previous.code) : undefined;
      if (conceptId !== undefined && previousConceptId !== undefined) {
        await db
          .insert(conceptEdges)
          .values({ fromConceptId: previousConceptId, toConceptId: conceptId, kind: 'prereq' })
          .onConflictDoNothing();
        summary.conceptEdges += 1;
      }
    }
  }

  // Soft cross-track edges, so recommendations prefer the natural order without
  // locking anybody out of a track they are ready for.
  for (let i = 1; i < SYLLABUS.length; i += 1) {
    const previousTrack = SYLLABUS[i - 1];
    const track = SYLLABUS[i];
    if (!previousTrack || !track) continue;

    const firstModule = track.modules[0];
    const lastModule = previousTrack.modules[previousTrack.modules.length - 1];
    if (!firstModule || !lastModule) continue;

    const entry = (lessonIdsByModule.get(firstModule.code) ?? [])[0];
    const previousIds = lessonIdsByModule.get(lastModule.code) ?? [];
    const gate = previousIds[previousIds.length - 1];

    if (entry !== undefined && gate !== undefined) {
      await db
        .insert(lessonPrereqs)
        .values({ lessonId: entry, prereqLessonId: gate, hard: false })
        .onConflictDoNothing();
      summary.prereqEdges += 1;
    }
  }

  // --------------------------------------------------------------- roadmaps
  for (const [index, roadmap] of ROADMAPS.entries()) {
    await db
      .insert(roadmaps)
      .values({
        slug: roadmap.slug,
        title: roadmap.title,
        persona: roadmap.persona,
        durationWeeks: roadmap.durationWeeks,
        path: [...roadmap.path],
        position: index + 1,
      })
      .onConflictDoUpdate({
        target: roadmaps.slug,
        set: {
          title: roadmap.title,
          persona: roadmap.persona,
          durationWeeks: roadmap.durationWeeks,
          path: [...roadmap.path],
          position: index + 1,
        },
      });
    summary.roadmaps += 1;
  }

  // ------------------------------------------------- interview bank sampler
  //
  // §7 gates the bank at 20 questions on Free and "full 240" above, and the
  // gate is `position <= allowance`; the seed provides enough to exercise both
  // sides of that boundary.
  const demoCompany = await db
    .insert(companies)
    .values({
      slug: 'redquant-demo',
      name: 'RedQuant Demo Systems',
      modality: 'superconducting',
      stack: ['qiskit', 'openqasm'],
      briefing: 'A stand-in employer used by the seeded interview questions.',
    })
    .onConflictDoUpdate({ target: companies.slug, set: { name: 'RedQuant Demo Systems' } })
    .returning({ id: companies.id });

  const companyId = demoCompany[0]?.id ?? null;

  for (let position = 1; position <= 24; position += 1) {
    const kind = position % 3 === 0 ? 'system_design' : position % 3 === 1 ? 'coding' : 'conceptual';
    await db
      .insert(questions)
      .values({
        slug: `demo-question-${String(position).padStart(3, '0')}`,
        kind,
        title: `Interview question ${position}`,
        prompt: `Placeholder prompt for seeded interview question ${position}.`,
        difficulty: ((position - 1) % 5) + 1,
        trackId: trackIdByCode.get('T7') ?? null,
        companyId,
        rubric: [
          { criterion: 'Correctness', weight: 0.6 },
          { criterion: 'Resource efficiency', weight: 0.4 },
        ],
        freeTier: position <= 20,
        position,
      })
      .onConflictDoNothing();
  }

  // ------------------------------------------------ demo org, instructor, cohort
  const passwords = createPasswordHasher(env);

  const orgRow = await db
    .insert(orgs)
    .values({
      slug: 'demo-university',
      name: 'Demo University',
      kind: 'campus',
      emailDomain: 'demo.redquant.io',
      domainVerified: true,
      seatLimit: 200,
      billingEmail: 'bursar@demo.redquant.io',
    })
    .onConflictDoUpdate({
      target: orgs.slug,
      set: { name: 'Demo University', domainVerified: true, seatLimit: 200 },
    })
    .returning({ id: orgs.id });

  const orgId = orgRow[0]?.id;
  if (orgId === undefined) throw new Error('Demo organisation was not inserted.');

  // Campus entitlements come from an org subscription, which is what makes the
  // instructor dashboard visible to the seeded instructor (§7).
  await db
    .insert(subscriptions)
    .values({
      orgId,
      planCode: 'campus',
      status: 'active',
      seats: 200,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000),
    })
    // `subscriptions_org_key` is a *partial* unique index (`where org_id is not
    // null`), which an `ON CONFLICT (org_id)` target cannot match; the bare form
    // catches it and keeps the seed re-runnable.
    .onConflictDoNothing();

  const demoPassword = 'redquant-demo-password';
  const passwordHash = await passwords.hash(demoPassword);

  const people = [
    {
      email: 'instructor@demo.redquant.io',
      handle: 'demo-instructor',
      displayName: 'Dr Ada Reyes',
      role: 'instructor' as const,
    },
    {
      email: 'student1@demo.redquant.io',
      handle: 'demo-student-1',
      displayName: 'Kofi Mensah',
      role: 'learner' as const,
    },
    {
      email: 'student2@demo.redquant.io',
      handle: 'demo-student-2',
      displayName: 'Lena Vogel',
      role: 'learner' as const,
    },
  ];

  const entitlementService = createEntitlementService(
    { primary: db, replica: db } as unknown as DatabaseHandles,
    // The seed only ever calls `provisionNewUser` and `recompute`, neither of
    // which touches Redis beyond writing a stamp, so a no-op client is enough.
    {
      set: async () => 'OK',
      get: async () => null,
    } as unknown as Parameters<typeof createEntitlementService>[1],
  );

  const userIdByEmail = new Map<string, string>();

  for (const person of people) {
    const inserted = await db
      .insert(users)
      .values({
        email: person.email,
        emailVerified: true,
        displayName: person.displayName,
        handle: person.handle,
        passwordHash,
        role: person.role,
        orgId,
      })
      .onConflictDoNothing()
      .returning({ id: users.id });

    let userId = inserted[0]?.id;
    if (userId === undefined) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${person.email}`)
        .limit(1);
      userId = existing[0]?.id;
    }
    if (userId === undefined) throw new Error(`Demo user ${person.email} was not inserted.`);

    userIdByEmail.set(person.email, userId);
    summary.demoUsers += 1;

    await db
      .insert(orgMembers)
      .values({
        orgId,
        userId,
        role: person.role === 'instructor' ? 'instructor' : 'member',
        seatAssigned: true,
      })
      .onConflictDoNothing();

    await entitlementService.provisionNewUser(db, userId);
    await entitlementService.recompute(userId, db);
  }

  const instructorId = userIdByEmail.get('instructor@demo.redquant.io') as string;

  const cohortRow = await db
    .insert(cohorts)
    .values({
      orgId,
      ownerId: instructorId,
      name: 'Quantum Computing I — Autumn 2026',
      slug: 'qc1-autumn-2026',
      term: 'Autumn 2026',
      trackId: trackIdByCode.get('T1') ?? null,
      joinCode: 'QC1A2026',
    })
    .onConflictDoUpdate({
      target: [cohorts.orgId, cohorts.slug],
      set: { name: 'Quantum Computing I — Autumn 2026', ownerId: instructorId },
    })
    .returning({ id: cohorts.id });

  const cohortId = cohortRow[0]?.id;
  if (cohortId === undefined) throw new Error('Demo cohort was not inserted.');

  for (const email of ['student1@demo.redquant.io', 'student2@demo.redquant.io']) {
    const userId = userIdByEmail.get(email);
    if (!userId) continue;
    await db
      .insert(cohortMembers)
      .values({ cohortId, userId, role: 'student' })
      .onConflictDoNothing();
  }

  const firstT1Module = SYLLABUS.find((track) => track.code === 'T1')?.modules[0];
  const assignmentLessonIds = firstT1Module
    ? (lessonIdsByModule.get(firstT1Module.code) ?? []).slice(0, 4)
    : [];

  await db
    .insert(assignments)
    .values({
      cohortId,
      title: 'Week 1 — The Qubit',
      instructions: 'Complete the first four lessons of T1.M1 and pass the module checkpoint.',
      lessonIds: assignmentLessonIds,
      points: 100,
      dueAt: new Date(Date.now() + 7 * 86_400_000),
      published: true,
      createdBy: instructorId,
    })
    .onConflictDoNothing();

  return summary;
}
/* eslint-enable no-await-in-loop */

async function main(): Promise<void> {
  const env = loadEnv();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    const db = drizzle(client, { schema });
    const summary = await seed(db as Db, env);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && process.argv[1].endsWith('seed.ts');

if (isEntrypoint) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(
        `seed failed\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    });
}
