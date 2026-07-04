import { describe, expect, it } from 'vitest';
import { TenantContextService } from '../src/tenancy/tenant-context.service';

describe('TenantContextService', () => {
  it('throws outside a tenant scope (iron rule #1)', () => {
    const ctx = new TenantContextService();
    expect(() => ctx.requireClinicId()).toThrow(/No tenant context/);
  });

  it('exposes the clinicId inside run()', () => {
    const ctx = new TenantContextService();
    const result = ctx.run({ clinicId: 'clinic-1', userId: 'user-1' }, () =>
      ctx.requireClinicId(),
    );
    expect(result).toBe('clinic-1');
  });

  it('isolates concurrent async scopes', async () => {
    const ctx = new TenantContextService();
    const read = (clinicId: string, delayMs: number) =>
      ctx.run({ clinicId, userId: 'u' }, async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return ctx.requireClinicId();
      });

    const [a, b] = await Promise.all([read('clinic-a', 20), read('clinic-b', 5)]);
    expect(a).toBe('clinic-a');
    expect(b).toBe('clinic-b');
  });

  it('does not leak scope after run() resolves', () => {
    const ctx = new TenantContextService();
    ctx.run({ clinicId: 'clinic-1', userId: 'u' }, () => undefined);
    expect(ctx.get()).toBeUndefined();
  });

  it('supports the middleware+guard pattern: set() fills an open store for later readers', async () => {
    // Mirrors HTTP flow: middleware opens empty store around the whole chain;
    // the guard (a separate async step) fills it; the controller reads it.
    const ctx = new TenantContextService();
    const clinicId = await ctx.runEmpty(async () => {
      expect(ctx.get()).toBeUndefined(); // open but unfilled
      await Promise.resolve(); // async boundary, as between guard and handler
      ctx.set({ clinicId: 'clinic-1', userId: 'u' });
      await Promise.resolve();
      return ctx.requireClinicId();
    });
    expect(clinicId).toBe('clinic-1');
  });

  it('set() outside an open store throws (middleware missing)', () => {
    const ctx = new TenantContextService();
    expect(() => ctx.set({ clinicId: 'c', userId: 'u' })).toThrow(/TenantContextMiddleware/);
  });
});
