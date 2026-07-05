// Dev seed: one clinic with a sample catalog and a login (owner@dalio.dev / dalio-dev-123).
// Idempotent — safe to re-run. Usage: pnpm db:seed (after pnpm db:migrate).
import { config } from 'dotenv';
config({ path: '../../.env' });
config();

import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
// Static imports are safe here: nothing below reads env at import time —
// ConfigService/createAuth only read it when invoked, after dotenv ran.
import { createAuth } from '../auth/auth';
import * as schema from './schema';

const SEED_EMAIL = 'owner@dalio.dev';
const SEED_PASSWORD = 'dalio-dev-123';
const SEED_ORG_SLUG = 'clinica-demo';

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client, { schema });

  const existing = await db.query.clinics.findFirst({
    where: eq(schema.clinics.slug, SEED_ORG_SLUG),
  });
  if (existing) {
    console.log('Seed already applied, nothing to do.');
    await client.end();
    return;
  }

  // Create the auth user through better-auth so the password hash is correct.
  const configService = new ConfigService(process.env as Record<string, unknown>);
  const auth = createAuth(db, configService);

  const signUp = await auth.api.signUpEmail({
    body: { email: SEED_EMAIL, password: SEED_PASSWORD, name: 'Dono Demo' },
  });
  const userId = signUp.user.id;

  const orgId = randomUUID();
  await db.insert(schema.organization).values({
    id: orgId,
    name: 'Clínica Demo',
    slug: SEED_ORG_SLUG,
    createdAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId,
    role: 'owner',
    createdAt: new Date(),
  });

  const [clinic] = await db
    .insert(schema.clinics)
    .values({
      authOrgId: orgId,
      name: 'Clínica Demo',
      slug: SEED_ORG_SLUG,
      settings: {
        workingHours: {
          1: { open: '09:00', close: '19:00' },
          2: { open: '09:00', close: '19:00' },
          3: { open: '09:00', close: '19:00' },
          4: { open: '09:00', close: '19:00' },
          5: { open: '09:00', close: '19:00' },
          6: { open: '09:00', close: '14:00' },
        },
        sendWindow: { start: '08:00', end: '20:00' },
        debounceMs: 7000,
      },
    })
    .returning();

  await db.insert(schema.professionals).values([
    { clinicId: clinic!.id, name: 'Ana Paula' },
    { clinicId: clinic!.id, name: 'Juliana' },
  ]);

  await db.insert(schema.services).values([
    {
      clinicId: clinic!.id,
      name: 'Limpeza de pele',
      priceCents: 18000,
      durationMin: 60,
      returnIntervalDays: 30,
    },
    {
      clinicId: clinic!.id,
      name: 'Alongamento de cílios',
      priceCents: 22000,
      durationMin: 90,
      returnIntervalDays: 21,
    },
    {
      clinicId: clinic!.id,
      name: 'Drenagem linfática',
      priceCents: 15000,
      durationMin: 50,
      returnIntervalDays: 14,
    },
  ]);

  console.log(`Seeded clinic "${clinic!.name}" (${clinic!.id})`);
  console.log(`Login: ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
