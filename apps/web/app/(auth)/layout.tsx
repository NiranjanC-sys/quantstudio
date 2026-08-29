import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="rq-auth-shell">
      <Link href="/" className="rq-brand rq-auth-brand" aria-label="RedQuant home">
        <span className="rq-brand-mark" aria-hidden="true" />
        RedQuant
      </Link>
      <main id="main">{children}</main>
    </div>
  );
}
