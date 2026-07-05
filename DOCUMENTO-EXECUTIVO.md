# Dalio — Documento Executivo

**Sistema comercial de WhatsApp para clínicas de estética**
Versão 1.0 · 04 de julho de 2026 · Documento de arquitetura e estratégia pré-planejamento

---

## 1. Sumário Executivo

O Dalio é um SaaS multi-tenant que ataca as quatro principais fontes de perda de receita de clínicas de estética que operam pelo WhatsApp:

1. **No-show** — faltas em horários agendados (15–30% é a taxa típica do setor; cada cadeira vazia é receita perecível).
2. **Leads perdidos** — leads não respondidos em menos de 5 minutos perdem o interesse e fecham com o concorrente que respondeu primeiro.
3. **Leads fora do horário comercial** — mensagens recebidas à noite e nos fins de semana que nunca são convertidas.
4. **Reativação de clientes antigos** — serviços de estética são recorrentes por natureza (botox a cada 4–6 meses, alongamento de cílios a cada 3 semanas), mas as clínicas não rastreiam o ciclo e os clientes simplesmente somem.

**Insight arquitetural central:** os quatro problemas colapsam em apenas **dois motores**:

- **Motor conversacional de entrada** (resolve os problemas 2 e 3): um agente de IA que responde em segundos, 24/7, qualifica o lead e **agenda de verdade** — não apenas conversa.
- **Motor de mensagens agendadas de saída** (resolve os problemas 1 e 4): a mensagem certa na hora certa — cadências de lembrete atreladas a agendamentos e campanhas de reativação atreladas à data da última visita.

Ambos compartilham uma camada de conversas, uma camada de configuração por clínica e uma camada de canal WhatsApp. Esse é o modelo de domínio central.

**A proposta de valor é mensurável em reais:** o dashboard deve exibir, como métricas-herói, no-shows recuperados, leads respondidos em <1 minuto, leads capturados fora do horário e clientes reativados — cada um com estimativa em R$. Esse dashboard é a ferramenta de retenção do produto.

---

## 2. Especificações Técnicas

### 2.1 Stack

| Camada | Tecnologias |
|---|---|
| Backend | NestJS (Node.js), LangChain/LangGraph, Better-auth, BullMQ, Drizzle ORM |
| Banco de dados | PostgreSQL auto-hospedado na Hetzner (container com volume dedicado; backups WAL contínuos + PITR próprios) |
| Fila / cache | Redis (requisito do BullMQ — **incluir na infraestrutura desde o dia um**) |
| Canal WhatsApp | WAHA (canal permanente) com chips fornecidos pela empresa; API oficial mantida como seguro/hedge |
| Frontend | Next.js/React, shadcn/ui, react-query, axios, Better-auth |
| Infraestrutura | Docker · Hetzner (backend) · Vercel (frontend) · GitHub Actions (CI/CD) |
| Observabilidade | LangSmith (traces de LLM — nativo do LangGraph; workspace região EU + DPA + masking p/ LGPD), Bull Board (filas), Sentry, monitor de saúde de sessões WAHA |

### 2.2 Arquitetura: monólito modular multi-tenant

**Decisão firmada: multi-tenant** com banco único, schema compartilhado e `clinic_id` em todas as tabelas — reforçado por camada de repositório (nenhuma query pode esquecer o filtro) e, opcionalmente, RLS no Postgres (`SET app.tenant_id`) como defesa em profundidade. A alternativa single-tenant (uma instância Hetzner por clínica) foi avaliada e **rejeitada**: o custo operacional de gerenciar 500 instâncias (deploys, migrações, versões divergentes, logs distribuídos) e o COGS linear (~€4.000/mês vs. ~€150–300/mês) são incompatíveis com precificação SMB (R$300–800/mês por clínica).

**Não iniciar com microsserviços.** Módulos NestJS:

- `tenancy` — clínicas como organizações (plugin de organizações do Better-auth); configuração por clínica: serviços, preços, horários, persona do agente, cadência de lembretes.
- `channels` — abstração de provedor de mensagens, ciclo de vida de sessões (pareamento QR, health checks, reconexão), ingestão de webhooks.
- `conversations` — log de mensagens, estado da conversa, flag de handoff humano.
- `agent` — grafo LangGraph: roteamento de intenção → qualificação → agendamento → handoff. Checkpointer no Postgres. Catálogo da clínica injetado no prompt (1–2k tokens; **RAG é desnecessário**).
- `scheduling` — agendamentos, lembretes, preenchimento de vagas via lista de espera.
- `campaigns` — segmentos de reativação e envios.

**Isolamento híbrido de canal ("cérebro compartilhado, bocas isoladas"):**

```
PLANO DE CONTROLE (multi-tenant, 2–3 servidores Hetzner)
  App NestJS · Postgres · Redis/BullMQ · Workers LangGraph · API do dashboard

PLANO DE CANAL (isolado por clínica)
  waha-clinica-042: container próprio · engine NOWEB/GOWS · proxy dedicado · número próprio
  → ~30–50 containers por host; tabela `channels` mapeia clínica → container/host
```

Isso entrega o que a arquitetura single-tenant prometia contra banimentos (IP próprio por clínica, contenção do raio de explosão) mantendo app, dados, filas e deploys singulares. Uma clínica banida é um container a reprovisionar, não um servidor entre 500.

---

## 3. Problemas Críticos e Soluções

### 3.1 Pipeline de mensagens (o coração técnico do produto)

Três problemas encadeados — ingestão, agrupamento e serialização — cuja ausência produz bugs reconhecíveis em produção já na primeira semana:

| Problema | Solução | Invariante garantida |
|---|---|---|
| Webhook lento → retries do WAHA → duplicatas | Handler faz apenas **validar → enfileirar → 200 OK** (≤50ms). Dedupe em duas camadas: `SET NX` no Redis (pré-filtro) + `jobId` determinístico no BullMQ (garantia real, atômica com o enfileiramento). Sem acesso a banco no handler — só Redis. | Capturado durably, exatamente uma vez |
| Rajadas de mensagens ("oi" / "vcs fazem limpeza?" / "quanto custa" em 8s) → 3 respostas sobrepostas do LLM | **Debounce por conversa** (~7s, janela deslizante com teto de ~20–25s): buffer em lista Redis + flush job com delay no BullMQ. Indicador "digitando..." durante a espera. Mensagens de áudio transcritas no drain (áudio é enorme no WhatsApp brasileiro). | Um turno de agente por rajada |
| Dois turnos de agente simultâneos na mesma conversa → respostas intercaladas e contraditórias | **Mutex por conversa** (Redis, token + TTL 90s, release via compare-and-delete em Lua) com **drain-loop**: quem detém o lock re-drena o buffer antes de soltar, respondendo mensagens que chegaram durante o turno. Contenção re-enfileira (nunca bloqueia worker). Substitui os grupos do BullMQ Pro (pago) com ~40 linhas. | Um turno por vez, nenhum perdido |

Regras complementares: takeover humano via inbox do dashboard (com o número dedicado da empresa, a recepcionista não tem o app deste número — a pausa explícita no inbox substitui a auto-pausa por `fromMe`), respostas estruturadas ("1"/"2") pulam o debounce, e este trecho (~200 linhas) merece a maior densidade de testes de integração do projeto — simulando tempestades de mensagens com jitter aleatório contra um WAHA fake.

### 3.2 Estratégia de canal: WAHA permanente com números da empresa

**Decisão: WAHA é o canal definitivo** ("WAHA até sermos forçados a mudar"), não uma fase transitória. Justificativa: as regras rígidas da API oficial — janela de 24h, aprovação lenta de templates, custo por mensagem exatamente na reativação (a feature de maior ROI), verificação de negócio da Meta por clínica — são incompatíveis com o segmento SMB brasileiro. O perfil de tráfego do produto (inbound-heavy, contatos conhecidos, atrelado a agendamentos) é favorável ao uso não-oficial; concorrentes brasileiros operam assim há anos.

**Modelo de número: chip fornecido pela empresa (parte do serviço de consultoria).** Cada clínica recebe um número dedicado do agente, de propriedade da empresa. Consequências:

- **O número principal da clínica nunca corre risco** — o cenário catastrófico (banir a linha de negócio do cliente) é eliminado por construção.
- Pareamento QR e ciclo de vida da sessão são centralizados na operação da empresa — sem depender do dono da clínica escanear QR às 21h.
- Banimento vira **incidente operacional recuperável**: contatos (chaveados por telefone), histórico de conversas e agendamentos vivem no banco e sobrevivem à troca de número.

**Recuperação de banimento — o problema não são os dados, é a alcançabilidade e a confiança:**

- **Links de redirecionamento próprios** (`dominio.com/wa/clinica-x` → `wa.me/numero-atual`) em toda superfície publicada — bio do Instagram, Google Business, anúncios. Troca de número = atualizar um redirect em segundos, não caçar links espalhados. **Nunca publicar o número cru.**
- **Pool de números pré-aquecidos em standby** (5–10% da frota): warm-up leva 2–4 semanas e **não pode começar depois do ban**. Com o pool, a recuperação é de horas, não semanas.
- **Protocolo de retomada proativa**: o banco sabe exatamente quem estava em conversa ativa ou agendamento em andamento no momento do ban; o número novo re-contata essas pessoas com contexto e se reapresenta ("Aqui é a assistente da Clínica X — nosso número mudou"). Sem isso, quem estava no meio de um agendamento responde para um número morto e some.

**Operação de SIMs no Brasil:** chips registrados no CNPJ da empresa; recargas mínimas automatizadas (pré-pago expira); atenção a números reciclados pela operadora (podem carregar reputação ruim no WhatsApp); DDD compatível com a cidade da clínica (confiança do destinatário); SIM bank ou eSIM para receber SMS de verificação centralizadamente.

**A abstração de provedor permanece — como seguro, não como plano de migração.** Intenções estruturadas, registro de templates e modelagem da janela de 24h custam ~1 semana e compram três coisas: saída de emergência se uma onda de banimento da Meta forçar a mão (dias para migrar, não meses, com clientes pagantes no ar), capacidade de atender franquias/clínicas maiores que exijam a API oficial, e a opção futura de reativação via templates oficiais se a economia mudar.

**Consequências de produto do número dedicado:**

- A recepcionista não tem o app deste número → **o inbox do dashboard é o único canal humano da clínica**. A auto-pausa por `fromMe` deixa de existir; o takeover é 100% via dashboard — a qualidade do inbox vira crítica para adoção.
- Leads novos precisam chegar ao número do agente: anúncios, bio e links apontam para ele (sempre via redirect próprio); o número pessoal/principal da clínica segue com os relacionamentos existentes.
- Toda primeira mensagem proativa se apresenta ("assistente da Clínica X") — número desconhecido exige construção de confiança para minimizar denúncias de spam.

### 3.3 Anti-ban: disciplina própria, não serviço terceirizado

Serviços de "antiban" vendem majoritariamente o que deve viver no próprio pipeline de saída — auditável e sob controle:

- **Warm-up de números**: rampa de ~10 msgs/dia ao longo de 2–4 semanas (tabela de config + rate limiter existente).
- **Humanização**: indicador de digitação, jitter aleatório entre envios, janelas de envio em horário comercial.
- **Variação de copy**: nunca enviar texto byte-idêntico a N destinatários; variantes de template + slots de variável.
- **Opt-out em segundos**: denúncia de spam é o sinal nº 1 de banimento; "não quero mais receber" deve ser flag mecânica verificada em todo envio (que também é a base LGPD).
- **Caps rígidos**: ≤50 envios de reativação/dia por número no WAHA; campanha de 400 clientes sai em duas semanas, não numa tarde (o drip também protege a capacidade de atendimento da clínica).
- **Proxies comprados diretamente** (residenciais/móveis, ~US$3–15/mês por sessão, geolocalizados no Brasil, **estáveis** por sessão — rotação no meio da sessão parece roubo de conta). Rotear conversas de pacientes por fornecedor de mercado cinza é exposição LGPD.

**Subsistema de números (módulo `numbers`)** — com WAHA permanente, anti-ban deixa de ser "disciplina no pipeline" e vira subsistema de primeira classe: ciclo de vida do número como máquina de estados (`provisioning → warming → active → degraded → banned → replaced`); score de qualidade por número alimentado por taxas de falha de entrega; cotas diárias em função de idade e score (não uma constante global); **números canário** que imitam o comportamento da frota como indicador antecedente de ondas de detecção; e atualizações de engine WAHA/Baileys tratadas como infraestrutura crítica — versões pinadas, rollout escalonado pela frota (um update ruim pode derrubar todas as sessões de uma vez), capacidade de rodar engines mistas. Transparência contratual com as clínicas: o ToS divulga a natureza não-oficial do canal e define o processo de substituição de número.

**Fator tranquilizador:** o perfil de risco do caso de uso é moderado — tráfego majoritariamente iniciado pelo cliente e para contatos conhecidos. A zona de perigo é uma única feature: reativação em volume.

### 3.4 Soluções por problema de negócio

**No-show — cadência + válvula de escape + backfill.** Confirmação imediata no agendamento; T-24h pedido de confirmação ("responda 1/2"); T-3h lembrete; **"2" → o agente remarca ali mesmo** (remarcação sem atrito converte no-show em receita movida, não perdida); silêncio em T-2h → alerta no dashboard + oferta da vaga à lista de espera (a feature que transforma donos de clínica em evangelistas); follow-up na noite do no-show. Implementação: máquina de estados do agendamento (`scheduled → confirmed → completed | no_show | cancelled | rescheduled`), linhas de `reminder` geradas da cadência configurável por clínica, e **scanner por minuto** (cron BullMQ) em vez de jobs com delay longo — agendamentos remarcam o tempo todo e regenerar linhas é trivial. Envios sempre dentro da janela da clínica (nada de lembrete às 3h da manhã).

**Leads <5min — agente cuja função é agendar, não conversar.** Orçamento de latência: primeira resposta <60s incluindo debounce, p95 do turno <15s. Grafo: roteador (modelo barato: lead novo / cliente / resposta de confirmação / handoff) → qualificação (catálogo no prompt) → **agendamento com disponibilidade real do calendário** (o nó onde está o dinheiro) → handoff (pedido explícito, baixa confiança, reclamação, ou **qualquer pergunta clínica — o agente jamais dá conselho médico, escala**).

**Fora do horário — o mesmo motor, sem expediente.** Branch de handoff noturno com expectativa honesta ("nossa equipe responde a partir das 9h") + agendamento completo de madrugada se o calendário é nativo — o demo-manchete do produto: *"lead escreveu 23h12, acordou com horário confirmado"*. Digest matinal para a clínica (conversas da noite, agendamentos feitos, pendências por urgência). Horário de silêncio vale só para saída; entrada responde sempre.

**Reativação — recorrência por serviço, não blast genérico.** `return_interval` por serviço → data de retorno implícita por cliente → nudge personalizado pelo histórico ("Oi Ana! Já faz 3 semanas do seu alongamento…") cuja resposta cai no mesmo agente, que agenda. **Regras de supressão** que evitam o tiro no pé: opt-out, agendamento futuro existente, contatado nos últimos N dias, conversa ativa. É a feature de maior risco de ban → o argumento mais forte para templates da API oficial (R$0,04–0,30/conversa contra ticket de R$200 é trivialmente positivo).

**O fio que une tudo: um contato, uma conversa.** O mesmo telefone é lead hoje, destinatário de lembrete semana que vem, alvo de reativação em um mês — e no meio do lembrete pergunta "aliás, quanto custa a drenagem?". Tabela única de `contacts` por clínica chaveada no telefone, linha do tempo única de conversa, e roteador que sempre sabe qual contexto de fluxo está pendente. Quatro fluxos em silos mostram as costuras na primeira semana de uso real.

---

## 4. Considerações para o Beta (~10 clínicas)

**Escopo recomendado:**

- ✅ Agente de entrada (leads <5min + fora do horário) — risco de ban baixo, valor imediato e demonstrável.
- ✅ Fluxo anti-no-show — atrelado a agendamentos existentes, risco baixo.
- ✅ Calendário nativo do produto (clínicas sem sistema são os clientes mais fáceis; integrações Google Calendar/Trinks ficam para depois).
- ⚠️ **Reativação com caps rígidos e drip desde o início** — com número da empresa, um ban é incidente operacional (troca de chip do pool), não existencial. Ainda assim, os 10 pilotos são design partners: começar conservador (≤50/dia) e considerar um segundo número de campanha (sacrificável) quando o volume crescer.

**Requisitos inegociáveis já no beta:**

- O trio do pipeline (idempotência + debounce + lock) completo — clínicas reais o exercitam na primeira semana.
- Handoff humano com inbox ao vivo no dashboard — com o número dedicado da empresa, o inbox é o **único** canal humano da clínica; a qualidade dele decide a adoção.
- Links de redirecionamento próprios desde o primeiro cliente (nunca publicar número cru) e pelo menos 1–2 números pré-aquecidos em standby antes de ativar campanhas.
- Observabilidade: LangSmith com workspace na região EU, DPA assinado e política de masking de PII (será preciso responder "por que o bot disse isso?" a donos de clínica irritados), monitor de sessões WAHA com alerta de queda/re-pareamento (o incidente operacional nº 1 em produtos WAHA), Bull Board, lag de enfileiramento como métrica de backpressure.
- LGPD: captura de consentimento no primeiro contato, opt-out mecânico no pipeline, suporte a exclusão de dados.
- Métricas em R$ no dashboard desde o dia um — é o argumento de renovação.
- Abstração de provedor como seguro (intenções estruturadas, templates, janela de 24h modelada) — ~1 semana de custo que compra a saída de emergência caso uma onda de banimento da Meta force a migração.

**Infra do beta:** um único servidor Hetzner (CPX41/CCX23) com Docker Compose roda API + workers + Redis confortavelmente; containers WAHA separados do app (crash de sessão não derruba o produto); Postgres auto-hospedado no mesmo host (container com volume dedicado, conexão direta do Drizzle — pgBouncer só quando houver necessidade real) com **backups WAL contínuos (pgBackRest/WAL-G) para um Hetzner Storage Box e restore de PITR ensaiado — responsabilidade nossa, não de um provedor gerenciado**; deploy via GitHub Actions → GHCR → Coolify ou Kamal.

---

## 5. Escala de Longo Prazo (500 clínicas)

**A boa notícia:** 500 clínicas é pequeno em tráfego bruto — ~50 conversas/clínica/dia ≈ 25k conversas e 300–500k mensagens/dia ≈ poucos msgs/segundo em média. Um único servidor decente aguenta o app. As pressões reais de escala estão em outro lugar:

| Pressão | Plano |
|---|---|
| **Sessões WhatsApp** (a parte pesada) | NOWEB ~30MB/sessão → 500 sessões ≈ 15–20GB em 2–3 hosts dedicados de canal; sharding por clínica; mapeamento sessão→instância no banco; na Cloud API esse custo simplesmente desaparece |
| **Custo de LLM** (a verdadeira economia unitária) | Tiering de modelos: barato/rápido (classe Haiku) para roteamento e FAQ, forte só para negociação de agendamento; orçamento de tokens por tenant com alertas — uma clínica tagarela não pode comer a margem |
| **Fan-in de webhooks** | Filtrar eventos na porta (acks/presence são 10–50× o volume de mensagens); escalar workers horizontalmente guiado pela métrica de lag |
| **Operação de SIMs em escala** | ~500 chips no CNPJ com recargas automatizadas; SIM bank/eSIM; pool de standby aquecido (5–10% da frota); DDDs regionais; provisionamento e substituição progressivamente sem toque humano |
| **Deploy e operação** | Continuar monólito modular até dor real; 2–3 nós + load balancer quando preciso; rollouts staged |

**Evoluções previstas conforme o produto amadurece:** automação crescente da operação de números (provisionamento, warm-up e substituição sem toque humano), integrações de calendário externas, analytics agregado entre clínicas ("clínicas como a sua confirmam 78%"), API oficial como tier para franquias/clínicas maiores que a exijam (via a abstração de provedor já existente), e — se surgir demanda — um **tier premium single-tenant** precificado para carregar o próprio peso operacional (nunca como arquitetura padrão).

---

## 6. Riscos Principais

| Risco | Severidade | Mitigação |
|---|---|---|
| Banimento de número individual | Média (incidente operacional) | Chip da empresa (número da clínica nunca em risco) + pool de standby aquecido + links de redirect próprios + protocolo de retomada proativa |
| Onda de banimento em massa (detecção do cliente não-oficial pela Meta) | Alta (risco de cauda — atinge a frota inteira) | Abstração de provedor como saída de emergência; números canário; engines pinadas com rollout escalonado; monitorar upstream WAHA/Baileys |
| Sessão WAHA caindo (re-pareamento QR) | Média (incidente op. nº 1) | Pareamento centralizado na empresa + monitor de saúde + auto-restart |
| Custo LLM descontrolado | Média | Tiering + orçamento por tenant + traces LangSmith |
| Clínica não adota o inbox do dashboard | Alta (é o único canal humano) | UX do inbox como prioridade nº 1 do frontend; digest matinal; notificações |
| Conselho médico pelo agente | Alta (responsabilidade) | Guardrail rígido de escalação em temas clínicos |
| LGPD (campanhas a dados pessoais) | Média | Consentimento + opt-out mecânico + exclusão |
| Dependência de updates WAHA/Baileys (arms race com a Meta) | Média | Versões pinadas, rollout escalonado, engines mistas, releases upstream como input de monitoramento |

---

## 7. Próximos Passos

1. Schema Drizzle do domínio: `clinics`, `channels`, `contacts`, `conversations`, `messages`, `appointments`, `reminders`, `campaigns`, `templates`.
2. Scaffolding dos módulos NestJS com o pipeline webhook → fila → debounce → lock (com a suíte de testes de tempestade de mensagens).
3. Desenho detalhado do grafo LangGraph (roteador, estados, checkpointing, handoff).
4. Pipeline de saída (outbox, rate limiter por canal, FIFO por conversa).
5. Dashboard: inbox de handoff + métricas-herói em R$.

---

*Documento gerado a partir das discussões de arquitetura de julho/2026. Decisões registradas: multi-tenant confirmado; WAHA como canal permanente com chips fornecidos pela empresa (modelo consultoria); abstração de provedor mantida como seguro, não como plano de migração; isolamento híbrido de canal; anti-ban como subsistema de primeira classe (módulo `numbers`).*
