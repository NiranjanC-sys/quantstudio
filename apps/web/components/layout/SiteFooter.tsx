import Link from 'next/link';

const COLUMNS = [
  {
    title: 'Learn',
    links: [
      { href: '/curriculum', label: 'Curriculum' },
      { href: '/roadmaps', label: 'Roadmaps' },
      { href: '/dashboard', label: 'Your progress' },
    ],
  },
  {
    title: 'Build',
    links: [
      { href: '/lab', label: 'Circuit lab' },
    ],
  },
  {
    title: 'Compete',
    links: [
      { href: '/contests', label: 'Weekly contests' },
      { href: '/leaderboard', label: 'Leaderboard' },
      { href: '/interview', label: 'Interview bank' },
    ],
  },
  {
    title: 'Institutions',
    links: [
      { href: '/pricing', label: 'Teams and Campus' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="rq-site-footer">
      <div className="rq-footer-grid">
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <h2 className="rq-eyebrow">{c.title}</h2>
            <ul>
              {c.links.map((l) => (
                <li key={l.href}><Link href={l.href}>{l.label}</Link></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="rq-footer-note">
        Curriculum benchmarked against 20 published syllabi. Every lesson cites its sources.
      </p>
    </footer>
  );
}
