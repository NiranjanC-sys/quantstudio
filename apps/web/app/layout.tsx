import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, Newsreader, IBM_Plex_Mono } from 'next/font/google';
import '@/styles/globals.css';

const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument', display: 'swap' });
const serif = Newsreader({ subsets: ['latin'], variable: '--font-newsreader', display: 'swap', style: ['normal', 'italic'] });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'RedQuant', template: '%s · RedQuant' },
  description:
    'Learn quantum computing by building it. A 306 lesson curriculum, a circuit builder that simulates as you type, autograded labs and weekly rated contests.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FBFAF8' },
    { media: '(prefers-color-scheme: dark)', color: '#08090B' },
  ],
};

/**
 * Applied before first paint so a stored theme choice never flashes the wrong
 * palette. Kept as a string rather than a component because it must run
 * synchronously in <head>.
 */
const NO_FLASH = `
try {
  var t = localStorage.getItem('rq-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body className={`${sans.variable} ${serif.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
