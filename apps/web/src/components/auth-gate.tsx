'use client';

// Session + clinic gate for authenticated pages. Better-auth organizations
// map 1:1 to clinics (Phase 0: clinics.authOrgId); the api's TenantGuard
// refuses /api/v1 calls without an ACTIVE organization, so this gate makes
// sure one exists before any inbox query fires:
//   no session → /login · no active org → picker (or auto-pick when single).
import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { data: organizations, isPending: orgsPending } = authClient.useListOrganizations();

  const activeOrgId = session?.session.activeOrganizationId;

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  // Single-clinic users (the common case) never see the picker.
  useEffect(() => {
    if (session && !activeOrgId && organizations?.length === 1) {
      void authClient.organization.setActive({ organizationId: organizations[0]!.id });
    }
  }, [session, activeOrgId, organizations]);

  if (isPending || !session || orgsPending) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-32 w-80" />
      </main>
    );
  }

  if (!activeOrgId) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Selecione a clínica</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {organizations?.length ? (
              organizations.map((org) => (
                <Button
                  key={org.id}
                  variant="outline"
                  className="justify-start"
                  onClick={() =>
                    void authClient.organization.setActive({ organizationId: org.id })
                  }
                >
                  {org.name}
                </Button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                Sua conta ainda não está vinculada a nenhuma clínica. Fale com o suporte Dalio.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  return <>{children}</>;
}
