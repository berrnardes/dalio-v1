// DTOs of the inbox API (apps/api/src/inbox) as consumed by the dashboard.
// InboxEvent (the SSE wire format) comes from @dalio/shared — same contract
// both sides; these read models mirror inbox.repository.ts return shapes.
import type {
  ConversationStatus,
  DeliveryStatus,
  MessageDirection,
  MessageKind,
  MessageSource,
  OutboundIntent,
} from '@dalio/shared';

export interface ConversationListItem {
  id: string;
  status: ConversationStatus;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  optedOut: boolean;
  pausedUntil: string | null;
  pausedByUserId: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessage: {
    id: string;
    direction: MessageDirection;
    source: MessageSource;
    kind: MessageKind;
    status: DeliveryStatus;
    preview: string;
    createdAt: string;
  } | null;
  pendingDrafts: number;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  source: MessageSource;
  kind: MessageKind;
  body: { text?: string; mediaUrl?: string; caption?: string };
  intent: OutboundIntent | null;
  transcription: string | null;
  status: DeliveryStatus;
  createdAt: string;
}

export interface MorningDigest {
  since: string;
  activeConversations: Array<{
    conversationId: string;
    contactName: string | null;
    contactPhone: string;
    lastInboundAt: string | null;
    pausedUntil: string | null;
  }>;
  appointmentsBooked: Array<{
    appointmentId: string;
    contactName: string | null;
    contactPhone: string;
    serviceName: string;
    startsAt: string;
    source: string;
  }>;
  pendingHandoffs: Array<{
    conversationId: string;
    contactName: string | null;
    contactPhone: string;
    pausedUntil: string;
    pausedByUserId: string | null;
  }>;
  pendingDraftCount: number;
}
