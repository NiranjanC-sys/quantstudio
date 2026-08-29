/**
 * Generates (once) a fixed Ed25519 service-token keypair and writes it to
 * results/service-key.json.
 *
 * WHY: with no SERVICE_JWT_PRIVATE_KEY configured, the gateway mints an
 * EPHEMERAL keypair per process (auth/service-jwt.ts), so nothing outside that
 * process can mint a token the gateway will accept. The contest scoring path
 * (§6 step 3, POST /contests/:id/verdict) is only reachable with such a token,
 * and there is no grader-worker service in this repo — so the load-test harness
 * has to be the grader. Starting the gateway with a known keypair is the only
 * way to close that loop. This is a load-test-environment setting, printed by
 * tools/start-gateway.sh, never a production one.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'results', 'service-key.json');

if (existsSync(OUT)) {
  process.stdout.write(readFileSync(OUT, 'utf8'));
} else {
  const pair = generateKeyPairSync('ed25519');
  const json = JSON.stringify({
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  process.stdout.write(json);
}
