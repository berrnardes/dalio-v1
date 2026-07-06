// Production migration runner — Phase 7. Dev uses drizzle-kit (a dev
// dependency); the production image must not carry the toolkit, so this tiny
// runner applies the committed ./drizzle folder with drizzle-orm's own
// migrator and exits. The container entrypoint runs it before the app
// (DEPLOYMENT.md): migrations are strictly-forward and idempotent by journal.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = postgres(url, { max: 1 });
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  await client.end();
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
