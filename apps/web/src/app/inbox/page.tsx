'use client';

// The inbox — Phase 3, frontend priority #1 (TASKS.md). Company-SIM model
// means this screen is the clinic's ONLY way to talk to clients as a human:
// live conversation list + thread, supervised-draft approval, and the
// morning digest, all kept fresh by the SSE stream (no polling).
import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { useInboxStream } from '@/hooks/use-inbox-stream';
import { AuthGate } from '@/components/auth-gate';
import { Button } from '@/components/ui/button';
import { ConversationList, useConversations } from '@/components/inbox/conversation-list';
import { DigestCard } from '@/components/inbox/digest-card';
import { Thread } from '@/components/inbox/thread';

export default function InboxPage() {
  return (
    <AuthGate>
      <Inbox />
    </AuthGate>
  );
}

function Inbox() {
  useInboxStream();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: conversations } = useConversations();
  const { data: session } = authClient.useSession();
  const { data: organizations } = authClient.useListOrganizations();

  const activeOrg = organizations?.find(
    (o) => o.id === session?.session.activeOrganizationId,
  );
  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  async function signOut() {
    await authClient.signOut();
    router.replace('/login');
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold tracking-tight">Dalio</span>
          {activeOrg && <span className="text-sm text-muted-foreground">{activeOrg.name}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{session?.user.email}</span>
          <Button variant="ghost" size="icon" title="Sair" onClick={() => void signOut()}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-r border-border bg-card">
          <DigestCard onOpenConversation={setSelectedId} />
          <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <main className="min-w-0 flex-1">
          {selected ? (
            <Thread conversation={selected} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Selecione uma conversa para acompanhar ou assumir o atendimento.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
