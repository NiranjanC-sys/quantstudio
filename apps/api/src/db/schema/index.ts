/**
 * Aggregate schema entry point. Drizzle Kit reads this file (compiled) to diff
 * against `src/db/migrations`; the application imports the same symbols.
 *
 * `labs.submissions` and `contest.submissions` share a table name, so they are
 * re-exported here under distinct aliases rather than with `export *`.
 */
export * as identitySchema from './identity.js';
export * as catalogSchema from './catalog.js';
export * as progressSchema from './progress.js';
export * as labsSchema from './labs.js';
export * as contestSchema from './contest.js';
export * as billingSchema from './billing.js';
export * as socialSchema from './social.js';
export * as instructorSchema from './instructor.js';

export * from './identity.js';
export * from './catalog.js';
export * from './progress.js';
export * from './billing.js';
export * from './social.js';
export * from './instructor.js';

export {
  labs,
  submissionLanguage,
  submissionStatus,
  artefactKind,
  submissions as labSubmissions,
  submissionResults,
  artefacts,
} from './labs.js';

export {
  contest,
  contestKind,
  contestStatus,
  registrationKind,
  verdict,
  snapshotKind,
  contests,
  problems,
  registrations,
  submissions as contestSubmissions,
  standingsSnapshots,
  standingsRows,
  ratings,
  ratingHistory,
} from './contest.js';
