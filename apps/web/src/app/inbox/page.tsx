'use client';

// The inbox — Phase 3, frontend priority #1 (TASKS.md). Company-SIM model
// means this screen is the clinic's ONLY way to talk to clients as a human:
// live conversation list + thread, supervised-draft approval, and the
// morning digest, all kept fresh by the SSE stream (no polling).
import { useState } from 'react';
import { useInboxStream } from '@/hooks/use-inbox-stream';
import { AuthGate } from '@/components/auth-gate';
import { AppHeader } from '@/components/app-header';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: conversations } = useConversations();
  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-screen flex-col">
      <AppHeader />

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
