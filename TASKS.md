# Dalio — Backlog por Fases

Status: `[ ]` pendente · `[~]` em andamento · `[x]` concluído
Regra: fases em ordem (sequenciadas por risco — ver DOCUMENTO-EXECUTIVO §7 e considerações finais). Dentro da fase, ordem sugerida. Atualizar status ao concluir; divergências de design → atualizar SPEC.md.

---

## Fase 0 — Fundações ✅ (2026-07-04)

- [x] Monorepo pnpm (`apps/api`, `apps/web`, `packages/shared`) + TypeScript estrito + ESLint/Prettier
- [x] `docker-compose.dev.yml`: Postgres (porta 5433 no host), Redis, WAHA (NOWEB, atrás de profile)
- [x] NestJS scaffold + config por env validada (zod) — app recusa boot com env inválido
- [x] Drizzle: schema completo do SPEC §3 + migration `0000` aplicada + seed de dev idempotente
- [x] Better-auth com plugin de organizações; ponte `clinics.authOrgId`; TenantMiddleware (E2E verificado: 401 sem sessão, dados scoped com sessão)
- [x] Repositórios tenant-scoped (base + ServicesRepository de exemplo; testes do TenantContext)
- [x] `packages/shared`: `InboundMessageEvent`, `OutboundIntent`, enums (pgEnums derivam daqui)
- [x] CI: lint + typecheck + testes em PR
- [x] Preencher seção Commands do CLAUDE.md

## Fase 1 — Pipeline de mensagens ✅ (2026-07-04; gate de tempestade verde)

- [x] Webhook WAHA: HMAC-SHA512 (fail-closed em prod), filtros (fromMe/grupos/broadcast/eventos), dedupe 2 camadas, enqueue-only
- [x] Worker `inbound`: normalização → canal → clínica → upsert contato → mensagem (backstop de dedupe) → buffer Redis
- [x] Debounce: janela deslizante (default 7s, por clínica) com teto 25s, flush job com limpeza de tombstone*, typing indicator 1×/rajada
- [x] Lock por conversa (token + TTL 90s + compare-and-del Lua) com drain-loop e resgate pós-release; contenção re-enfileira
- [x] `WahaProvider` (text/choice numerado/media; parse de replies; template recusado — resolve upstream) + registry por canal
- [x] Fila `outbound` com outbox, FIFO por conversa (cursor uuidv7), gap com jitter por canal, cap diário só p/ proativos, gate `canContact`
- [x] Fila `transcription` integrada ao buffer (provider Null até decisão Whisper — pendência abaixo)
- [x] Fila `session-health`: status WAHA → `channels.status` + auto-restart em FAILED (alerta real: Fase 7)
- [x] **Testes de tempestade** (Testcontainers, gate de merge): 3 invariantes E2E — encontraram 1 bug real (*tombstone de jobId completado estrangulava rajadas subsequentes)
- [x] Testes de contrato do `MessagingProvider` (suíte compartilhada Waha+Cloud) + stub `CloudApiProvider` com janela de 24h real
- [x] Testes dedicados do outbound worker (FIFO sob contenção, caps) — coberto na Fase 4 (primeiro tráfego proativo real: cap diário exercitado na suíte de reminders)

## Fase 2 — Agente + calendário nativo ✅ (2026-07-05)

- [x] CRUD `services`/`professionals`/`appointments` + motor de disponibilidade (grade 30min, capacidade = profissionais ativos, wall-clock no fuso da clínica via TZDate, lead mínimo 60min, re-checagem no book)
- [x] Grafo LangGraph: router (Haiku 4.5) → book (Opus 4.8 + 4 ferramentas reais, loop máx. 6 → handoff gracioso) | answer_faq (tier barato) | handoff | opt-out
- [x] Catálogo/persona no prompt; toda saída como `OutboundIntent`; estado = histórico do banco (checkpointer Postgres dispensado conscientemente — divergência documentada no SPEC §5)
- [x] Guardrail médico (rota obrigatória no router, "na dúvida, medical") + opt-out determinístico pré-LLM (keyword) + intenção `opt_out` no router como segunda rede
- [x] Branch fora-do-expediente do handoff (mensagem honesta; digest matinal → Fase 3)
- [x] LangSmith: tracing via env (`LANGSMITH_*`), tag `clinic_id`/`conversation_id` por turno; custo LLM por clínica → `usage_counters` (tiering: Haiku $1/$5, Opus 4.8 $5/$25 por MTok)
- [x] Regressão de FLUXO com modelos fake: roteamento, guardrail, tool loop (resultado volta como ToolMessage), exaustão, opt-out — sem rede, sem tokens
- [ ] Avaliação de QUALIDADE com LLM real (env-gated por `ANTHROPIC_API_KEY`; transcrições reais quando o piloto gerar dados)
- [x] Testes dedicados do outbound worker (FIFO sob contenção, caps) — pendência herdada da Fase 1, resolvida na Fase 4

## Fase 3 — Inbox de handoff ✅ (2026-07-05; único canal humano — prioridade nº 1 do frontend)

- [x] Next.js + Better-auth + Tailwind v4/componentes shadcn-style; login + seleção de clínica (organização ativa; auto-seleção quando única)
- [x] Inbox ao vivo (SSE via Redis pub/sub por clínica — eventos só com ids, conteúdo nunca no bus): lista de conversas com preview/badges, timeline com cursor uuidv7, envio humano (outbox `source='human'` + auto-pausa 8h)
- [x] Pause/resume explícito; indicador "agente ativo/pausado" na lista e na thread
- [x] Modo supervisionado (`clinics.settings.supervisedMode`): agente rascunha (`status='draft'`), humano aprova (draft→queued, guarded contra dupla aprovação) ou descarta (auditoria mantida); opt-out determinístico NUNCA espera aprovação; bug corrigido: histórico do agente agora é allowlist (drafts eram visíveis pelo blocklist antigo)
- [x] Digest matinal (`GET /conversations/digest`): conversas da noite, agendamentos, handoffs pendentes, rascunhos — card expansível no inbox
- [x] Testes: 11 de integração (Testcontainers, auth Better-auth REAL: sign-up→org→set-active→guards; SSE de ponta a ponta; outbound worker completa envios aprovados) + 4 unitários do modo supervisionado — 93 no total, tempestade verde

## Fase 4 — Motor anti-no-show ✅ (2026-07-05)

- [x] Máquina de estados de `appointments` (confirm/cancel/no-show/complete com guards de status) + geração de `reminders` pela cadência da clínica (`AppointmentLifecycleService` = único caminho de escrita; offsets por clínica com default 24h/3h/2h; dueAt já passado é pulado no booking)
- [x] Scanner 1/min (fila `reminders-scan`, `upsertJobScheduler` idempotente → um ticker por N instâncias) → re-lê o conjunto DUE a cada tick (cancelamento/remarcação sempre honrados) → intents `choice` de confirmação + `flowContext.awaiting_confirmation`
- [x] Fluxos: confirmação T-24h, lembrete T-3h, at-risk T-2h, follow-up pós-no-show (+60min); resposta de confirmação parseada DETERMINISTICAMENTE antes de qualquer LLM (funciona sem API key)
- [x] Remarcação (opção "Remarcar" ou agente) cancela lembretes + libera vaga; o rebooking pelo agente regenera a cadência via lifecycle
- [x] Lista de espera + backfill: cancelamento/no-show notifica 1 candidato compatível por vaga (template `waitlist_slot_open`; sem estouro de manada)
- [x] Janela de envio da clínica respeitada no scanner (`settings.sendWindow`, default 08:00–20:00 no fuso da clínica) — deferimento, nunca descarte
- [x] Testes: 10 unitários (cadência/parse/janela/cancel) + 6 de integração (scanner→confirmação armada, deferimento fora da janela, opt-out cancela sem enviar, "1" confirma sem LLM, backfill da waitlist, cap diário do outbound worker) — resolve a pendência herdada da Fase 1/2

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

- ~~`@thallesp/nestjs-better-auth`~~ — adotado (refactor de 2026-07-04)
- ~~Modelos LLM por tier~~ — decidido: Haiku 4.5 (router/FAQ) + Opus 4.8 (booking), env-configurável; orçamento por clínica com alertas fica p/ Fase 7
- Provedor de transcrição (Whisper self-hosted vs. API) — Fase 1 (provider Null no ar)
- ~~SSE vs. Supabase Realtime~~ — decidido: SSE + Redis pub/sub (Supabase saiu da stack em 2026-07-04; WebSocket só se SSE ficar curto)
- Fornecedor de proxies residenciais/móveis e de SIMs — Fase 6
