# Dalio — Especificação Técnica

Versão 1.0 · 04/07/2026 · Documento vivo — atualizar quando a realidade divergir do plano.
Contexto de negócio e decisões de arquitetura: ver [DOCUMENTO-EXECUTIVO.md](DOCUMENTO-EXECUTIVO.md). Status de execução: ver [TASKS.md](TASKS.md).

---

## 1. Escopo do v1 e não-objetivos

**No v1:** pipeline de mensagens completo (idempotência + debounce + lock), agente conversacional com agendamento em calendário nativo, inbox de handoff, motor anti-no-show, dashboard com métricas em R$, módulo de números com warm-up, campanhas de reativação com supressão e drip.

**Fora do v1 (deliberadamente):**
- Adapter da API oficial Cloud — **apenas a interface e os testes de contrato**, sem implementação (é o seguro, não o plano).
- Integrações de calendário externas (Google Calendar, Trinks).
- Billing/pagamentos das clínicas.
- Mensagens de grupo — **ignorar na porta do webhook** (filtrar `@g.us`).
- Chamadas de voz — WAHA não atende; evento de chamada perdida gera resposta automática de texto (fase 2+).

---

## 2. Estrutura do repositório

Monorepo pnpm workspaces:

```
apps/api        NestJS — backend, workers, webhooks
apps/web        Next.js — dashboard das clínicas
packages/shared Tipos canônicos: eventos, intents, enums (fonte única API↔web)
```

Deploy: `apps/api` → Docker/Hetzner · `apps/web` → Vercel · Postgres → auto-hospedado na Hetzner (container, volume dedicado, backups WAL/PITR via pgBackRest → Hetzner Storage Box) · Redis → container no host Hetzner.
Dev local: `docker-compose.dev.yml` com Postgres, Redis e WAHA (NOWEB).

---

## 3. Schema Drizzle (Postgres)

Convenções: PKs `uuid` (v7), timestamps `timestamptz`, dinheiro em `integer` centavos, telefones em E.164 (`+5511...`). **Toda tabela de domínio carrega `clinic_id`** e todo acesso passa pelo repositório tenant-scoped (§6). Identidade do contato é o telefone — nunca IDs de provedor.

```ts
// ── Núcleo multi-tenant ─────────────────────────────────────────────
clinics = pgTable('clinics', {
  id: uuid().primaryKey(),
  authOrgId: text().unique(),              // organização do Better-auth
  name: text().notNull(),
  slug: text().unique().notNull(),         // usado no redirect dominio.com/wa/<slug>
  timezone: text().default('America/Sao_Paulo'),
  status: clinicStatus().default('active'),          // active | suspended
  settings: jsonb().$type<ClinicSettings>(),         // persona do agente, horários,
                                                     // janela de envio, cadência de
                                                     // lembretes, debounceMs
  createdAt: timestamptz().defaultNow(),
});

professionals = pgTable('professionals', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  name: text().notNull(),
  active: boolean().default(true),
});

services = pgTable('services', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  name: text().notNull(),
  priceCents: integer().notNull(),
  durationMin: integer().notNull(),
  returnIntervalDays: integer(),           // motor de reativação; null = não recorrente
  active: boolean().default(true),
});

// ── Números e canais (módulo numbers — ver DOCUMENTO-EXECUTIVO §3.2/3.3) ──
numbers = pgTable('numbers', {
  id: uuid().primaryKey(),
  phone: text().unique().notNull(),        // E.164
  ddd: text().notNull(),                   // pareado com a cidade da clínica
  carrier: text(),
  state: numberState().notNull(),          // provisioning | warming | standby |
                                           // active | degraded | banned | retired
  clinicId: uuid().references(clinics.id), // null = pool de standby
  qualityScore: real().default(1.0),       // alimentado por falhas de entrega
  dailyQuota: integer().default(10),       // função de idade + score, não constante
  warmupStartedAt: timestamptz(),
  activatedAt: timestamptz(),
  bannedAt: timestamptz(),
  replacedById: uuid().references((): AnyPgColumn => numbers.id),
});

channels = pgTable('channels', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  provider: provider().notNull(),          // 'waha' | 'cloud_api'
  externalId: text().notNull(),            // WAHA: session name · Cloud: phone_number_id
  numberId: uuid().references(numbers.id),
  status: channelStatus().notNull(),       // provisioning | pairing | connected |
                                           // disconnected | failed
  host: text(),                            // host/container do plano de canal
  engine: text(),                          // 'noweb' | 'gows' — pinado por canal
  ratePolicy: jsonb().$type<RatePolicy>(), // caps, jitter, janela de envio
}, t => [unique().on(t.provider, t.externalId)]);

// ── Contatos e conversas ────────────────────────────────────────────
contacts = pgTable('contacts', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  phone: text().notNull(),
  name: text(),
  source: text(),                          // 'inbound' | 'import' | 'manual'
  consentAt: timestamptz(),                // LGPD — capturado no primeiro contato
  optOutAt: timestamptz(),                 // verificado mecanicamente em TODO envio
  lastVisitAt: timestamptz(),
  createdAt: timestamptz().defaultNow(),
}, t => [unique().on(t.clinicId, t.phone)]);

conversations = pgTable('conversations', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  contactId: uuid().references(contacts.id).notNull(),
  channelId: uuid().references(channels.id).notNull(),
  status: convoStatus().default('open'),   // open | closed
  pausedUntil: timestamptz(),              // handoff humano: agente mudo até aqui
  pausedByUserId: text(),
  flowContext: jsonb().$type<FlowContext>(), // o que está pendente: confirmação de
                                             // qual appointment, resposta de qual
                                             // campanha — o roteador lê isto
  lastInboundAt: timestamptz(),
  lastOutboundAt: timestamptz(),           // base do check canSendFreeform (24h)
});

messages = pgTable('messages', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  conversationId: uuid().references(conversations.id).notNull(),
  direction: direction().notNull(),        // inbound | outbound
  source: msgSource().notNull(),           // contact | agent | human | reminder |
                                           // campaign | system
  kind: msgKind().notNull(),               // text | audio | image | document |
                                           // template | system
  body: jsonb().$type<MessageBody>().notNull(),
  intent: jsonb().$type<OutboundIntent>(), // outbound: a intenção estruturada original
  transcription: text(),                   // áudio → Whisper, preenchido no drain
  providerMessageId: text(),
  status: deliveryStatus().default('queued'), // draft | discarded | queued | sent | delivered | read | failed
                                           // draft/discarded: modo supervisionado (Fase 3) — rascunho do
                                           // agente aguardando aprovação humana; só 'queued' entra no FIFO
  error: jsonb(),
  createdAt: timestamptz().defaultNow(),
}, t => [
  unique().on(t.clinicId, t.providerMessageId),      // backstop de dedupe
  index().on(t.conversationId, t.createdAt),
]);

// ── Agenda ──────────────────────────────────────────────────────────
appointments = pgTable('appointments', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  contactId: uuid().references(contacts.id).notNull(),
  serviceId: uuid().references(services.id).notNull(),
  professionalId: uuid().references(professionals.id),
  startsAt: timestamptz().notNull(),
  endsAt: timestamptz().notNull(),
  status: apptStatus().notNull(),          // scheduled → confirmed → completed |
                                           // no_show | cancelled | rescheduled
  rescheduledToId: uuid().references((): AnyPgColumn => appointments.id),
  source: text().notNull(),                // agent | human | reactivation
  createdAt: timestamptz().defaultNow(),
}, t => [index().on(t.clinicId, t.startsAt)]);

reminders = pgTable('reminders', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  appointmentId: uuid().references(appointments.id).notNull(),
  kind: reminderKind().notNull(),          // booking_confirmation | confirm_24h |
                                           // reminder_3h | at_risk_2h | no_show_followup
  dueAt: timestamptz().notNull(),
  sentAt: timestamptz(),                   // stamp transacional = idempotência
  cancelledAt: timestamptz(),              // remarcação cancela e regenera linhas
  messageId: uuid().references(messages.id),
}, t => [index('reminders_due').on(t.dueAt).where(isNull(t.sentAt), isNull(t.cancelledAt))]);

waitlist = pgTable('waitlist', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  contactId: uuid().references(contacts.id).notNull(),
  serviceId: uuid().references(services.id).notNull(),
  windowStart: timestamptz(),
  windowEnd: timestamptz(),
  notifiedAt: timestamptz(),
  fulfilledAppointmentId: uuid().references(appointments.id),
});

// ── Templates e campanhas ───────────────────────────────────────────
templates = pgTable('templates', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id),  // null = template global padrão
  key: text().notNull(),                    // referenciado por chave, nunca string crua
  category: templateCategory().notNull(),   // utility | marketing
  variants: jsonb().$type<string[]>().notNull(), // variação de copy anti-ban:
                                                 // sorteio por envio
  variables: jsonb().$type<string[]>(),     // slots: {{nome}}, {{servico}}, {{data}}
  providerStatus: jsonb(),                  // reservado p/ aprovação Meta (hedge)
}, t => [unique().on(t.clinicId, t.key)]);

campaigns = pgTable('campaigns', {
  id: uuid().primaryKey(),
  clinicId: uuid().references(clinics.id).notNull(),
  name: text().notNull(),
  kind: campaignKind().default('reactivation'),
  templateKey: text().notNull(),
  segment: jsonb().$type<SegmentRules>(),   // ex.: dias desde retorno esperado, serviço
  dailyCap: integer().default(20),          // drip — nunca acima da quota do número
  status: campaignStatus().default('draft'),// draft | running | paused | done
  startedAt: timestamptz(),
});

campaignRecipients = pgTable('campaign_recipients', {
  id: uuid().primaryKey(),
  campaignId: uuid().references(campaigns.id).notNull(),
  contactId: uuid().references(contacts.id).notNull(),
  scheduledFor: timestamptz(),
  sentAt: timestamptz(),
  suppressedReason: text(),                 // opt_out | future_appointment |
                                            // recently_contacted | active_conversation
  repliedAt: timestamptz(),
  convertedAppointmentId: uuid().references(appointments.id), // métrica em R$
});

// ── Medição por tenant ──────────────────────────────────────────────
usageCounters = pgTable('usage_counters', {
  clinicId: uuid().references(clinics.id).notNull(),
  month: text().notNull(),                  // '2026-07'
  inboundCount: integer().default(0),
  outboundCount: integer().default(0),
  llmTokensIn: bigint().default(0),
  llmTokensOut: bigint().default(0),
  llmCostCents: integer().default(0),
}, t => [primaryKey({ columns: [t.clinicId, t.month] })]);
```

Tabelas do Better-auth (users, sessions, organizations, members) são geradas pelo próprio Better-auth; `clinics.authOrgId` é a ponte. Checkpoints do LangGraph usam as tabelas do checkpointer Postgres oficial — estado conversacional do agente **não** duplica no nosso schema (o `flowContext` guarda apenas o apontador de contexto pendente).

---

## 4. Contratos do pipeline

### 4.1 Evento canônico de entrada (`packages/shared`)

```ts
interface InboundMessageEvent {
  provider: 'waha' | 'cloud_api';
  channelExternalId: string;      // resolve → channel → clinic no worker, nunca no handler
  providerMessageId: string;      // chave de idempotência
  from: string;                   // E.164
  timestamp: number;
  content:
    | { kind: 'text'; text: string }
    | { kind: 'audio'; mediaUrl: string }
    | { kind: 'image' | 'document'; mediaUrl: string; caption?: string };
}
```

### 4.2 Intenções de saída — **nenhum envio existe fora deste tipo**

```ts
type OutboundIntent =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; prompt: string; options: { id: string; label: string }[] }
    // WAHA renderiza "1) Confirmar 2) Remarcar" e parseia a resposta de volta
    // para option_id; Cloud API renderizaria botões. Fluxos só veem option_id.
  | { kind: 'template'; templateKey: string; variables: Record<string, string> }
  | { kind: 'media'; mediaUrl: string; caption?: string };
```

### 4.3 Filas BullMQ e chaves Redis

| Fila | Trabalho | Notas |
|---|---|---|
| `inbound` | normalizar, resolver canal→clínica, upsert contato, empurrar pro buffer | `jobId: msg:{providerMessageId}` (dedupe) |
| `agent` | flush jobs do debounce → turno do agente | `jobId: flush:{convoId}`, delay ~7s deslizante |
| `outbound` | envio com rate limit por canal, FIFO por conversa | outbox: linha em `messages` antes do envio |
| `reminders-scan` | repetível 1/min: lembretes vencidos → `outbound` | scanner, não delayed jobs |
| `campaign-dispatch` | diário: monta segmento, agenda drip respeitando supressão | |
| `session-health` | eventos de estado WAHA → alertas, auto-restart | |
| `transcription` | áudio → texto (Whisper) antes do turno | |

| Chave Redis | Papel | TTL |
|---|---|---|
| `dedupe:{providerMessageId}` | pré-filtro de redelivery (SET NX) | 24h |
| `buffer:{convoId}` | lista de mensagens da rajada | 5min |
| `buffer_started:{convoId}` | teto da janela deslizante (~25s) | 5min |
| `lock:agent:{convoId}` | mutex do turno (token + compare-and-del Lua) | 90s |

### 4.4 As três invariantes (testes de tempestade cobrem cada uma)

1. **Captura durável exatamente uma vez** — handler ≤50ms, só valida/enfileira/200; dedupe em duas camadas; 200 até para lixo (5xx só se Redis caiu); zero acesso a Postgres no handler.
2. **Um turno por rajada** — buffer + janela deslizante com teto; indicador "digitando" durante a espera; respostas estruturadas (opção de `choice` pendente no `flowContext`) pulam o debounce.
3. **Um turno em voo por conversa, nenhum perdido** — lock + drain-loop (quem detém re-drena antes de soltar); contenção re-enfileira com delay 3s, nunca bloqueia worker.

### 4.5 Interface do provedor (o seguro)

```ts
interface MessagingProvider {
  send(channel: Channel, to: string, intent: OutboundIntent): Promise<{ providerMessageId: string }>;
  parseInboundReply(raw: InboundMessageEvent, expecting?: ChoiceIntent): NormalizedReply;
  canSendFreeform(channel: Channel, convo: Conversation): boolean;  // WAHA: sempre true
  startTyping(channel: Channel, to: string): Promise<void>;
}
```

Suíte de testes de contrato compartilhada; `CloudApiProvider` fica como stub que passa os testes de tipo, sem implementação no v1.

---

## 5. Grafo do agente (implementado na Fase 2)

`router` (`AGENT_ROUTER_MODEL`, default `claude-haiku-4-5` — $1/$5 MTok) classifica em `booking | faq | medical | human | opt_out | smalltalk` →
- **`book`** (`AGENT_BOOKING_MODEL`, default `claude-opus-4-8` — $5/$25): loop de ferramentas hand-rolled (máx. 6 rodadas; exaustão → handoff gracioso) com `get_available_slots`, `book_appointment` (re-checa disponibilidade na hora — oferta pode estar obsoleta), `get_my_appointments`, `cancel_appointment`. Ferramentas são closures sobre o contato/clínica do turno — o LLM não consegue agendar cross-tenant.
- **`answer`** (FAQ/smalltalk no tier barato — catálogo no prompt, sem RAG).
- **`handoff`** (`medical`/`human`/exaustão): pausa a conversa 8h (`pausedUntil`) + mensagem honesta dentro/fora do expediente (digest matinal: Fase 3).
- **`optout`**: grava `contacts.optOutAt` + confirmação.

Regras invioláveis: nunca aconselhamento médico (rota obrigatória no router + regra no prompt); toda resposta sai como `OutboundIntent` via outbox; **opt-out determinístico por palavra-chave roda ANTES de qualquer LLM** (LGPD não depende de modelo); turno é pulado se `pausedUntil` futuro (humano é dono da thread); custo/token de cada chamada → `usage_counters` (via `AGENT_MODELS`); traces LangSmith com metadata `clinic_id`/`conversation_id`.

**Divergência consciente vs. o plano original:** sem checkpointer Postgres do LangGraph. Turnos rodam até o fim (sem interrupts), então o estado durável é a tabela `messages` (histórico, últimas 20) + `flowContext` — um checkpointer duplicaria isso sem ganho. Volta ao plano se interrupts/HITL dentro de turno surgirem.

---

## 6. Módulos NestJS e regras transversais

`tenancy` · `channels` · `numbers` · `conversations` · `agent` · `scheduling` · `campaigns` · `metrics` · `inbox`

- **Tenant scoping:** repositórios recebem `clinicId` do contexto de request (auth) ou do job payload; nenhuma query direta ao Drizzle fora dos repositórios de domínio.
- **Handoff:** `pausedUntil` na conversa; o inbox é o único canal humano (número é da empresa — não existe `fromMe` da clínica). Envio humano pelo inbox pausa o agente automaticamente.
- **LGPD:** todo envio outbound passa pelo gate `canContact(contact)` (opt-out, consentimento, frequência por contato). Conteúdo de mensagem não vai para logs de aplicação — só DB e Langfuse (self-hosted).

### 6.1 Padrão de documentação de código (obrigatório por feature)

Toda feature entregue deve carregar comentários abrangentes, em inglês, nestes três níveis:

1. **Cabeçalho de arquivo/módulo** — o que o módulo faz, seu papel na arquitetura e referência à seção do SPEC/DOCUMENTO-EXECUTIVO que o justifica (ex.: `// Debounce buffer — SPEC §4.4 invariant 2`).
2. **JSDoc em toda API pública** — services, repositórios, controllers, funções exportadas e tipos do `packages/shared`: o que faz, **por quê existe** (a regra de negócio ou risco que atende) e parâmetros/retornos quando não óbvios.
3. **Inline nos trechos densos** — pipeline, locks, máquinas de estado, grafo do agente, regras anti-ban: explicar a invariante protegida e as consequências de quebrá-la, não parafrasear a linha seguinte.

Regras: comentários explicam *intenção e restrição*, nunca narram o óbvio; comentário desatualizado é tratado como bug (atualiza junto com o código no mesmo commit); PRs/fases não são consideradas completas sem este padrão.

---

## 7. Superfície de API (dashboard)

Auth: Better-auth (sessão via cookie; organização ativa = clínica). Prefixo `/api/v1`.

| Recurso | Endpoints |
|---|---|
| Webhooks | `POST /webhooks/waha` (HMAC) · `GET/POST /webhooks/cloud` (stub) |
| Inbox | `GET /conversations?status=` · `GET /conversations/:id[/messages]` (cursor uuidv7 `?before=`) · `POST /conversations/:id/messages` (humano; auto-pausa 8h) · `POST /conversations/:id/pause\|resume` · `POST /conversations/:id/drafts/:messageId/approve\|reject` (modo supervisionado) · `GET /conversations/digest` (digest matinal, default últimas 16h) |
| Agenda | CRUD `appointments`, `services`, `professionals` · `GET /availability?serviceId&date` |
| Contatos | CRUD + import CSV · `POST /contacts/:id/optout` |
| Campanhas | CRUD `campaigns` · `POST /campaigns/:id/start\|pause` · preview de segmento com supressões |
| Canal | `GET /channel/status` · `POST /channel/pair` (QR — uso interno da operação) |
| Métricas | `GET /metrics/summary?month=` — as métricas-herói em R$ |

Tempo real do inbox (implementado na Fase 3): SSE (`GET /conversations/stream`), fan-out via Redis pub/sub (`inbox:events:{clinicId}`) para sobreviver a múltiplas instâncias da api. Eventos carregam SÓ ids (`InboxEvent` em `packages/shared`) — conteúdo nunca transita no bus; o dashboard invalida caches react-query e refaz o fetch pela REST autenticada.

**Modo supervisionado (Fase 3, rampa de confiança do piloto):** `clinics.settings.supervisedMode` — respostas do agente viram `messages.status='draft'` aguardando aprovação no inbox (aprovar = draft→queued com update guardado contra corrida + entra no FIFO normal; descartar = draft→discarded, mantido como trilha de auditoria). A confirmação de opt-out determinístico NUNCA espera aprovação (LGPD). Drafts/discarded são invisíveis no histórico do agente (allowlist sent/delivered/read).

---

## 8. Observabilidade e dev

- **LangSmith** (nativo do LangChain/LangGraph, zero-config via env `LANGSMITH_TRACING`/`LANGSMITH_API_KEY`) — trace de todo turno do agente; custo por clínica alimenta `usage_counters`. **LGPD:** workspace na região EU, DPA assinado com a LangChain Inc. e masking de PII configurado onde viável; a proibição de conteúdo de mensagem em logs de aplicação permanece — LangSmith é o único destino externo autorizado de traces. Projetos separados por ambiente (dev/prod) e tag `clinic_id` em todo trace para depurar por tenant.
- Bull Board em rota interna autenticada; métrica de lag enqueue→processing como gauge de backpressure.
- Sentry (api + web). Health: `GET /health` (DB, Redis, sessões WAHA conectadas vs. esperadas).
- Testes: Vitest; **testes de tempestade do pipeline** (rajadas com jitter aleatório contra WAHA fake via Testcontainers) são o gate de merge das Fases 0–1.
- CI (GitHub Actions): lint + typecheck + testes em PR; build de imagem + deploy (Coolify/Kamal) em merge na `main`.
