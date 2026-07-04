# Dalio — Backlog por Fases

Status: `[ ]` pendente · `[~]` em andamento · `[x]` concluído
Regra: fases em ordem (sequenciadas por risco — ver DOCUMENTO-EXECUTIVO §7 e considerações finais). Dentro da fase, ordem sugerida. Atualizar status ao concluir; divergências de design → atualizar SPEC.md.

---

## Fase 0 — Fundações

- [ ] Monorepo pnpm (`apps/api`, `apps/web`, `packages/shared`) + TypeScript estrito + ESLint/Prettier
- [ ] `docker-compose.dev.yml`: Postgres, Redis, WAHA (NOWEB)
- [ ] NestJS scaffold + config por env validada (zod)
- [ ] Drizzle: schema completo do SPEC §3 + migrations + seed de dev (1 clínica, catálogo exemplo)
- [ ] Better-auth com plugin de organizações; ponte `clinics.authOrgId`; middleware de tenant-context
- [ ] Repositórios tenant-scoped (base) — a regra de ferro nº 1 vira código
- [ ] `packages/shared`: `InboundMessageEvent`, `OutboundIntent`, enums
- [ ] CI: lint + typecheck + testes em PR
- [ ] Preencher seção Commands do CLAUDE.md

## Fase 1 — Pipeline de mensagens (o coração; gate: testes de tempestade verdes)

- [ ] Webhook WAHA: HMAC, filtro de eventos (grupos fora), dedupe 2 camadas, enqueue-only ≤50ms
- [ ] Worker `inbound`: normalização → canal → clínica → upsert contato → buffer Redis
- [ ] Debounce: janela deslizante ~7s com teto 25s, flush job `flush:{convoId}`, typing indicator
- [ ] Lock por conversa (token + TTL + compare-and-del Lua) com drain-loop; contenção re-enfileira
- [ ] `WahaProvider` (send de `text`/`choice`/`template`/`media`; parse de replies de choice)
- [ ] Fila `outbound` com outbox (linha em `messages` antes do envio), rate limit por canal, FIFO por conversa, jitter
- [ ] Fila `transcription` (áudio → Whisper) integrada ao drain
- [ ] Fila `session-health`: estados WAHA → alertas + auto-restart
- [ ] **Testes de tempestade**: rajadas com jitter aleatório vs. WAHA fake (Testcontainers) cobrindo as 3 invariantes
- [ ] Testes de contrato do `MessagingProvider` + stub `CloudApiProvider`

## Fase 2 — Agente + calendário nativo (o demo que vende)

- [ ] CRUD `services`, `professionals`, `appointments`; motor de disponibilidade (`GET /availability`)
- [ ] Grafo LangGraph: router (modelo barato) → qualify → book (modelo forte) → answer_faq → handle_choice_reply → handoff
- [ ] Checkpointer Postgres; catálogo/persona no prompt; toda saída como `OutboundIntent`
- [ ] Guardrail médico (rota obrigatória p/ handoff) + detecção de opt-out em qualquer nó
- [ ] Branch fora-do-expediente do handoff (expectativa honesta + tarefa p/ digest)
- [ ] Langfuse self-hosted + custo LLM por clínica → `usage_counters`
- [ ] Conjunto de avaliação: transcrições reais/sintéticas como regressão de qualidade

## Fase 3 — Inbox de handoff (único canal humano — prioridade nº 1 do frontend)

- [ ] Next.js + Better-auth + shadcn scaffold; seleção de clínica (organização)
- [ ] Inbox ao vivo (SSE): lista de conversas, timeline, envio humano (auto-pausa do agente)
- [ ] Pause/resume explícito; indicador de "agente ativo/pausado"
- [ ] Modo supervisionado (agente rascunha, humano aprova — rampa de confiança do piloto)
- [ ] Digest matinal (conversas da noite, agendamentos, pendências)

## Fase 4 — Motor anti-no-show

- [ ] Máquina de estados de `appointments` + geração de `reminders` pela cadência da clínica
- [ ] Scanner 1/min (fila `reminders-scan`) → intents `choice` de confirmação
- [ ] Fluxos: confirmação T-24h, lembrete T-3h, at-risk T-2h, follow-up pós-no-show
- [ ] Remarcação pelo agente cancela/regenera lembretes
- [ ] Lista de espera + backfill de vaga em risco/cancelada
- [ ] Janela de envio da clínica respeitada (nada às 3h da manhã)

## Fase 5 — Dashboard de métricas em R$

- [ ] `GET /metrics/summary`: no-shows recuperados, tempo mediano de 1ª resposta, leads fora do horário, agendamentos autônomos — cada um com estimativa em R$
- [ ] Telas no dashboard (métricas-herói) — o argumento de renovação

## Fase 6 — Módulo de números + reativação (por último, sobre infra provada)

- [ ] Módulo `numbers`: máquina de estados, quotas por idade/score, pool de standby aquecido
- [ ] Warm-up scheduler + números canário
- [ ] Redirects `dominio.com/wa/<slug>` → número atual (nunca publicar número cru)
- [ ] Runbook de banimento: detecção → substituição do pool → protocolo de retomada proativa
- [ ] Campanhas: builder de segmento por `returnIntervalDays`, supressões (opt-out, appointment futuro, contato recente, conversa ativa), drip com cap diário, variação de copy
- [ ] Conversão campanha → appointment (`convertedAppointmentId`) nas métricas

## Fase 7 — Endurecimento para o beta

- [ ] Deploy Hetzner (Coolify/Kamal) + Vercel; Postgres prod auto-hospedado com pgBackRest/WAL-G → Hetzner Storage Box; **restore de PITR ensaiado de verdade, não só configurado**
- [ ] Sentry, Bull Board, health checks, alertas de sessão
- [ ] LGPD: captura de consentimento, exclusão de dados, DPA + ToS (revisão jurídica externa)
- [ ] Checklist de onboarding por clínica (redirect na bio, anúncios, treino do inbox, catálogo) — clínica só ativa com checklist verde
- [ ] Definir e instrumentar métricas de sucesso do piloto (metas de no-show, <60s, agendamentos/mês)

---

## Decisões pendentes (resolver quando a fase chegar)

- Provedor de transcrição (Whisper self-hosted vs. API) — Fase 1
- Modelos LLM específicos por tier e orçamentos por clínica — Fase 2
- SSE vs. Supabase Realtime para o inbox — Fase 3
- Fornecedor de proxies residenciais/móveis e de SIMs — Fase 6
