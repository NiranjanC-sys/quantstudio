/**
 * The plan matrix from docs/architecture/system-design.md section 7.
 *
 * Kept as data rather than markup so the pricing page, the entitlement checks
 * in the API, and the upgrade prompts in the lab all quote the same numbers.
 */

export interface Plan {
  id: 'free' | 'pro' | 'teams' | 'campus';
  name: string;
  price: string;
  cadence: string;
  pitch: string;
  cta: string;
  featured?: boolean;
}

export const PLANS: Plan[] = [
  { id: 'free', name: 'Free', price: '$0', cadence: 'forever', pitch: 'The foundations and the core track, complete. Contests included.', cta: 'Start free' },
  { id: 'pro', name: 'Pro', price: '$19', cadence: 'per month', pitch: 'Every track, the interview bank, unlimited labs, 28 qubit simulation.', cta: 'Go Pro', featured: true },
  { id: 'teams', name: 'Teams', price: '$39', cadence: 'per seat, per month', pitch: 'Everything in Pro, plus instructor tooling and private contests.', cta: 'Start a team' },
  { id: 'campus', name: 'Campus', price: 'Custom', cadence: 'annual licence', pitch: 'Institutional licensing with SAML, SCIM and co-branded certificates.', cta: 'Talk to us' },
];

export interface FeatureRow {
  label: string;
  values: [string, string, string, string];
  group: string;
}

export const FEATURES: FeatureRow[] = [
  { group: 'Learn', label: 'Lessons', values: ['T0 and T1', 'All 8 tracks', 'All 8 tracks', 'All 8 tracks'] },
  { group: 'Learn', label: 'Spaced repetition drills', values: ['Yes', 'Yes', 'Yes', 'Yes'] },
  { group: 'Learn', label: 'Personalised path', values: ['No', 'Yes', 'Yes', 'Yes'] },
  { group: 'Build', label: 'Labs per month', values: ['40', 'Unlimited', 'Unlimited', 'Unlimited'] },
  { group: 'Build', label: 'Max qubits, statevector', values: ['16', '28', '30', '32'] },
  { group: 'Build', label: 'Noisy simulation', values: ['No', 'Up to 12 qubits', 'Up to 14 qubits', 'Up to 14 qubits'] },
  { group: 'Build', label: 'Simulation credits per month', values: ['500', '20,000', '50,000 per seat', 'Negotiated'] },
  { group: 'Assist', label: 'AI tutor messages per day', values: ['15', '300', '300', '300'] },
  { group: 'Compete', label: 'Contests', values: ['Participate', 'Rated, with editorials', 'Plus private contests', 'Plus private contests'] },
  { group: 'Compete', label: 'Interview bank', values: ['20 questions', 'All 240', 'All 240', 'All 240'] },
  { group: 'Teach', label: 'Instructor dashboard', values: ['No', 'No', 'Yes', 'Yes'] },
  { group: 'Teach', label: 'Certificates', values: ['No', 'Yes', 'Yes', 'Co-branded'] },
  { group: 'Account', label: 'Single sign on', values: ['Google, GitHub', 'Plus Microsoft, ORCID', 'Plus SAML', 'SAML and SCIM'] },
];
