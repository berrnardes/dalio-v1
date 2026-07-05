'use client';

// Shared dashboard chrome — logo, active clinic, section nav and sign-out.
// Extracted in Phase 5 when the app gained a second screen (inbox + metrics);
// keeping nav in one place is what keeps the sections discoverable.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChartNoAxesColumn, Inbox, LogOut } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const NAV = [
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/metrics', label: 'Métricas', icon: ChartNoAxesColumn },
] as const;

export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const { data: organizations } = authClient.useListOrganizations();

  const activeOrg = organizations?.find((o) => o.id === session?.session.activeOrganizationId);

  async function signOut() {
    await authClient.signOut();
    router.replace('/login');
  }

  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
      <div className="flex items-center gap-4">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold tracking-tight">Dalio</span>
          {activeOrg && <span className="text-sm text-muted-foreground">{activeOrg.name}</span>}
        </div>
        <nav className="flex items-center gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                pathname.startsWith(href)
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{session?.user.email}</span>
        <Button variant="ghost" size="icon" title="Sair" onClick={() => void signOut()}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
