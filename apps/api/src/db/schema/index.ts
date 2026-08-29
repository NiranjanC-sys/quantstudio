/**
 * Aggregate schema entry point. Drizzle Kit reads this file (compiled) to diff
 * against `src/db/migrations`; the application imports the same symbols, and
 * `drizzle(pool, { schema })` walks this module's exports to build its
 * relational config.
 *
 * That walk is why there are no `export * as <domain>Schema` namespace
 * re-exports here. A module namespace object has a null prototype, and Drizzle's
 * `is()` does `Object.getPrototypeOf(value).constructor` on every exported
 * value — a namespace export makes `drizzle()` throw at construction time.
 * Per-domain symbols are imported from their own file where a caller wants them.
 *
 * `labs.submissions` and `contest.submissions` share a table name, so they are
 * re-exported here under distinct aliases rather than with `export *`.
 */
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
