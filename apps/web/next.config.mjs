const isDev = process.env.NODE_ENV !== 'production';

/**
 * Content Security Policy.
 *
 * The lesson renderer compiles MDX and KaTeX into the page, and the lab renders
 * a WebGL Bloch sphere, so the policy has to allow inline styles and blob-backed
 * canvases. It does not have to allow a single byte of script from anywhere but
 * this origin, and that is the part that turns an injected `<script src>` or a
 * `javascript:` navigation into a console error instead of an account takeover.
 *
 * `'unsafe-inline'` in script-src is still here because the theme no-flash
 * script in app/layout.tsx and Next's own bootstrap are inline and unnonced.
 * Removing it means threading a per-request nonce through the root layout and
 * middleware; worth doing, but it is a rendering change, not a header change.
 * `'unsafe-eval'` is development-only — the dev server's HMR needs it, a
 * production build does not.
 */
function contentSecurityPolicy() {
  const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  let apiOrigin = api;
  try {
    apiOrigin = new URL(api).origin;
  } catch {
    // Leave the configured value alone if it is not a parseable URL; a broken
    // connect-src entry is better than a config file that throws at boot.
  }

  const directives = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    // `blob:` is required, not optional. Webpack's runtime instantiates workers
    // from blob URLs and those workers then `importScripts()` further blob
    // URLs, and importScripts inside a worker is governed by script-src rather
    // than worker-src. Without it the worker fails to rehydrate, React never
    // attaches its handlers, and the page renders correctly but does nothing.
    'script-src': ["'self'", "'unsafe-inline'", 'blob:', ...(isDev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'connect-src': ["'self'", apiOrigin, ...(isDev ? ['ws:', 'http://localhost:*'] : [])],
    'frame-src': ["'none'"],
    ...(isDev ? {} : { 'upgrade-insecure-requests': [] }),
  };

  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  poweredByHeader: false,
  transpilePackages: ['@redquant/qir', '@redquant/design', '@redquant/content'],
  experimental: { optimizePackageImports: ['three', '@react-three/drei'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // Cross-origin isolation is not required, so `same-site` rather than
          // `same-origin`: the app and the gateway are separate origins.
          { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
    ];
  },
};
export default nextConfig;
