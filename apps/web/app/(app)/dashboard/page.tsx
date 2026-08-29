import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { Dashboard } from '@/components/app/Dashboard';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Your experience, streak, review queue and what to study next.',
};

export default function DashboardPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Your progress.</h1>
          <Dashboard />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
