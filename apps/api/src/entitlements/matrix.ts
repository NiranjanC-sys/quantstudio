/**
 * The §7 plan matrix, transcribed from system-design exactly.
 *
 *  |                          | Free       | Pro ($19/mo)          | Teams ($39/seat) | Campus (annual)  |
 *  | Lessons                  | T0-T1      | all                   | all              | all              |
 *  | Labs / month             | 40         | unlimited             | unlimited        | unlimited        |
 *  | Max qubits (statevector) | 16         | 28                    | 30               | 32               |
 *  | Noisy simulation         | no         | yes, <= 12 q          | yes, <= 14 q     | yes, <= 14 q     |
 *  | Sim credits / month      | 500        | 20,000                | 50,000/seat      | negotiated       |
 *  | AI tutor messages / day  | 15         | 300                   | 300              | 300              |
 *  | Contests                 | participate| + rated + editorials  | + private        | + private        |
 *  | Interview bank           | 20         | full 240              | full             | full             |
 *  | Instructor dashboard     | no         | no                    | yes              | yes              |
 *  | SSO                      | Google/GitHub | + Microsoft, ORCID | + SAML          | + SAML, SCIM     |
 *  | Certificates             | no         | yes                   | yes              | co-branded       |
 *
 * Plus the per-plan server-simulation rate limit from §9 (30/min Free,
 * 240/min Pro), and the statevector memory guard from §4.
 */

export type PlanCode = 'free' | 'pro' | 'teams' | 'campus';

export type SsoProvider = 'google' | 'github' | 'microsoft' | 'orcid' | 'linkedin' | 'saml';

export type CertificateKind = 'none' | 'standard' | 'co-branded';

export interface Entitlements {
  plan: PlanCode;
  /** Highest track code readable, or `null` for the whole catalog. */
  maxTrackCode: string | null;
  /** `null` means unlimited. */
  labsPerMonth: number | null;
  /** §4 memory guard: statevector qubit ceiling for server-side simulation. */
  maxQubits: number;
  /** `null` when noisy (density-matrix) simulation is not included at all. */
  noisyMaxQubits: number | null;
  /**
   * Monthly simulation-credit grant. `null` means "negotiated per contract"
   * (Campus) — the grant then comes from the subscription row, not the matrix.
   */
  simCreditsPerMonth: number | null;
  tutorMessagesPerDay: number;
  contests: {
    participate: boolean;
    rated: boolean;
    editorials: boolean;
    private: boolean;
  };
  /** `null` means the full bank (240 questions). */
  interviewQuestions: number | null;
  instructorDashboard: boolean;
  sso: readonly SsoProvider[];
  scimProvisioning: boolean;
  certificates: CertificateKind;
  /** §9: server-simulation token bucket, per minute. */
  simulationsPerMinute: number;
}

type Matrix = { readonly [P in PlanCode]: Entitlements };

/**
 * Frozen at module load. `entitlementsFor()` never mutates a row from here; it
 * returns a fresh object, so a caller cannot poison another request's view.
 */
export const PLAN_MATRIX: Matrix = Object.freeze({
  free: Object.freeze({
    plan: 'free',
    maxTrackCode: 'T1',
    labsPerMonth: 40,
    maxQubits: 16,
    noisyMaxQubits: null,
    simCreditsPerMonth: 500,
    tutorMessagesPerDay: 15,
    contests: Object.freeze({ participate: true, rated: false, editorials: false, private: false }),
    interviewQuestions: 20,
    instructorDashboard: false,
    sso: Object.freeze(['google', 'github'] as const),
    scimProvisioning: false,
    certificates: 'none',
    simulationsPerMinute: 30,
  }),
  pro: Object.freeze({
    plan: 'pro',
    maxTrackCode: null,
    labsPerMonth: null,
    maxQubits: 28,
    noisyMaxQubits: 12,
    simCreditsPerMonth: 20_000,
    tutorMessagesPerDay: 300,
    contests: Object.freeze({ participate: true, rated: true, editorials: true, private: false }),
    interviewQuestions: null,
    instructorDashboard: false,
    sso: Object.freeze(['google', 'github', 'microsoft', 'orcid', 'linkedin'] as const),
    scimProvisioning: false,
    certificates: 'standard',
    simulationsPerMinute: 240,
  }),
  teams: Object.freeze({
    plan: 'teams',
    maxTrackCode: null,
    labsPerMonth: null,
    maxQubits: 30,
    noisyMaxQubits: 14,
    simCreditsPerMonth: 50_000,
    tutorMessagesPerDay: 300,
    contests: Object.freeze({ participate: true, rated: true, editorials: true, private: true }),
    interviewQuestions: null,
    instructorDashboard: true,
    sso: Object.freeze(['google', 'github', 'microsoft', 'orcid', 'linkedin', 'saml'] as const),
    scimProvisioning: false,
    certificates: 'standard',
    simulationsPerMinute: 240,
  }),
  campus: Object.freeze({
    plan: 'campus',
    maxTrackCode: null,
    labsPerMonth: null,
    maxQubits: 32,
    noisyMaxQubits: 14,
    simCreditsPerMonth: null,
    tutorMessagesPerDay: 300,
    contests: Object.freeze({ participate: true, rated: true, editorials: true, private: true }),
    interviewQuestions: null,
    instructorDashboard: true,
    sso: Object.freeze(['google', 'github', 'microsoft', 'orcid', 'linkedin', 'saml'] as const),
    scimProvisioning: true,
    certificates: 'co-branded',
    simulationsPerMinute: 240,
  }),
});

/** The full interview bank size (§7, "full 240"). */
export const INTERVIEW_BANK_SIZE = 240;
