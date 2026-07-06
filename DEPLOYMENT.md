# Dalio — Deploy & Operações (Fase 7)

Runbook do beta. Código de infra vive no repo (`Dockerfile`,
`docker-compose.prod.yml`, `ops/`); este documento é a sequência humana.
Itens marcados **[manual]** não são executáveis pelo repo — são a checklist
de operação/jurídico.

## 1. Topologia

- **Hetzner** (1 box, ex. CPX31): api (NestJS+workers), Postgres 17, Redis,
  e um container WAHA **por clínica** (`waha-<slug>`, proxy dedicado —
  DOCUMENTO-EXECUTIVO §2). Coolify gerencia builds/TLS/rollbacks.
- **Vercel**: `apps/web` (Next.js). Env: `NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_SENTRY_DSN`.
- **Hetzner Storage Box**: repositório pgBackRest (SFTP) — backups + WAL.

## 2. Primeira subida

1. **[manual]** Provisionar box Hetzner + Coolify; apontar DNS
   (`api.<domínio>` → box, `app.<domínio>` → Vercel).
2. Copiar `.env.production.example` → preencher no Coolify (segredos via
   `openssl rand`). LangSmith: workspace **região EU** (iron rule #7).
3. `docker compose -f docker-compose.prod.yml up -d` (ou Coolify build do
   `apps/api/Dockerfile`). O container aplica migrations no boot
   (`dist/db/migrate.js` — forward-only, idempotente por journal).
4. Vercel: importar o repo, root `apps/web`, build padrão Next.
5. Smoke: `GET https://api.<domínio>/health` → `status: ok` com `db`,
   `redis`, `channels`, `queues` verdes.

## 3. Backups & PITR (Postgres auto-hospedado)

1. `ops/pgbackrest/pgbackrest.conf` → preencher host/usuário do Storage Box
   e a chave SSH (`storagebox_ed25519`). `pgbackrest --stanza=dalio
   stanza-create && pgbackrest --stanza=dalio check`.
2. Cron no box: full semanal + diff diário —
   `0 3 * * 0 pgbackrest --stanza=dalio --type=full backup` ·
   `0 3 * * 1-6 pgbackrest --stanza=dalio --type=diff backup`.
   WAL flui contínuo via `archive_command` (compose).
3. **Ensaios de restore (obrigatório, mensal)** — `ops/backup/pitr-rehearsal.sh`
   restaura o último backup num container descartável, recupera até um
   ponto no tempo e prova que os dados respondem. *"Restore de PITR ensaiado
   de verdade, não só configurado"* (TASKS.md). Registrar cada ensaio aqui:

   | Data | Executor | Alvo PITR | Resultado |
   |---|---|---|---|
   | _pendente_ | | | |

## 4. Observabilidade

- **Sentry**: setar `SENTRY_DSN` (api) e `NEXT_PUBLIC_SENTRY_DSN` (web) —
  init é env-gated, sem DSN nada é carregado.
- **Bull Board**: `https://api.<domínio>/internal/queues` — habilitado só
  com `BULL_BOARD_PASSWORD` (basic auth `ops:<senha>`). Filas, lag e failed
  jobs por olho humano.
- **Alertas**: `ALERT_WEBHOOK_URL` (Slack/Discord/ntfy). Disparam em: sessão
  WAHA FAILED (+ falha de auto-restart), número degradado, **canário caindo**
  (campanhas pausadas em frota) e **pool de standby vazio** (o alerta que
  nunca pode disparar). Payloads carregam ids, nunca conteúdo (iron rule #7).
- **Health**: `GET /health` — db, redis, canais conectados vs esperados,
  filas (waiting + idade do job mais antigo = gauge de backpressure).

## 5. LGPD

- Consentimento: primeiro inbound grava `consentAt` (contato iniciou);
  import CSV exige a asserção `consent=true` da clínica; campanhas **só**
  enviam com `consentAt` presente (gate mecânico no `canContact`).
- Exclusão: `DELETE /api/v1/contacts/:id` — anonimiza o contato (telefone →
  tombstone, nome nulo), expurga corpo/transcrição das mensagens e remove
  waitlist/destinatários pendentes. Appointments ficam (registro contábil),
  já sem PII apontável.
- **[manual]** DPA LangSmith (workspace EU) assinado; DPA Anthropic; ToS
  com divulgação do canal não-oficial (DOCUMENTO-EXECUTIVO §3.2) —
  **revisão jurídica externa antes do primeiro contrato**.

## 6. Onboarding por clínica (gate de ativação)

`PUT /api/v1/clinic/onboarding` marca os itens; `POST /api/v1/clinic/activate`
recusa enquanto o checklist não estiver verde **e** não houver canal
conectado. Itens: redirect `/wa/<slug>` na bio/anúncios, anúncios apontados,
equipe treinada no inbox, catálogo preenchido. **[manual]** o treinamento em
si e a troca dos links publicados.

## 7. Metas do piloto

`GET /api/v1/metrics/pilot` — metas em `clinics.settings.pilotGoals`
(default: no-show ≤10%, ≥80% das respostas <60s, ≥20 agendamentos
autônomos/mês) vs. realizado no mês corrente. É a pauta da conversa mensal
com cada design partner.

## 8. Incidentes

- **Sessão WAHA caiu**: auto-restart já tentou; se `SCAN_QR_CODE`, re-parear
  (SIM é da empresa — tarefa nossa). Alerta chega no webhook.
- **Ban de número**: `POST /api/v1/numbers/:id/replace` (runbook completo no
  SPEC §4.7): standby mais aquecido entra, canais voltam a `provisioning`,
  re-parear, redirect `/wa/<slug>` já aponta certo. Retomada proativa via
  digest do inbox.
- **Onda de detecção (canário caiu)**: campanhas já pausadas em frota;
  segurar reativação, revisar upstream WAHA/Baileys antes de retomar.
