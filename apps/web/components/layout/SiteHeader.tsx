import Link from 'next/link';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { href: '/curriculum', label: 'Curriculum' },
  { href: '/lab', label: 'Lab' },
  { href: '/contests', label: 'Contests' },
  { href: '/interview', label: 'Interview' },
  { href: '/pricing', label: 'Pricing' },
];

export function SiteHeader() {
  return (
    <header className="rq-site-header">
      <a href="#main" className="rq-skip">Skip to content</a>
      <Link href="/" className="rq-brand" aria-label="RedQuant home">
        <span className="rq-brand-mark" aria-hidden="true" />
        RedQuant
      </Link>
      <nav aria-label="Main">
        <ul className="rq-nav">
          {NAV.map((n) => (
            <li key={n.href}><Link href={n.href}>{n.label}</Link></li>
          ))}
        </ul>
      </nav>
      <div className="rq-site-header-end">
        <ThemeToggle />
        <Link href="/login" className="rq-btn rq-btn-tertiary rq-btn-sm">Sign in</Link>
        <Link href="/signup" className="rq-btn rq-btn-primary rq-btn-sm">Start free</Link>
      </div>
    </header>
  );
}
