# 🦷 DentalFlow — Backend

API multi-tenant do DentalFlow, um SaaS de gestão para clínicas odontológicas.

Este repositório e [dentalflow-web](../dentalflow-web/README.md) formam o mesmo produto.
Documentação canônica: [índice](../dentalflow-web/docs/README.md),
[setup dos dois projetos](../dentalflow-web/docs/development/workspace.md),
[arquitetura](../dentalflow-web/docs/architecture/system.md),
[RF/RN/RNF](../dentalflow-web/docs/requirements/functional.md),
[contratos e todas as rotas](../dentalflow-web/docs/integrations/source-reference.md),
[produção](../dentalflow-web/docs/deployment/production-readiness.md) e
[auditoria atual](../dentalflow-web/docs/audit-report.md).
Links relativos pressupõem checkouts irmãos; os detalhes operacionais específicos
continuam neste repositório. Relatos históricos abaixo não comprovam o estado
atual de bancos ou ambientes em nuvem.

**Limites atuais:** pacientes são agregados de agendamentos por nome/e-mail;
PATIENT é onboarding Google, não portal; fiscal é simulação local;
WhatsApp tem envio manual, não agendador; falhas de processamento Stripe são
registradas mas respondidas com HTTP 200. Consulte os riscos antes de publicar.
Não execute o seed de demonstração em produção: ele inclui credenciais conhecidas
para contas de exemplo, inclusive ADMIN, e IDs Stripe específicos de um ambiente.

Para regras de desenvolvimento, testes e contribuição, leia
**[AGENTS.md](./AGENTS.md)** — é o documento normativo do repositório.

---

## ⚙️ Stack

- Node.js 24 · **Bun** como gerenciador de pacotes e runner de scripts
- NestJS 11 · TypeScript
- Prisma 7 · PostgreSQL
- Stripe (assinaturas) · Resend (e-mail) · OpenAI (assistente) · WhatsApp Cloud API
- Jest · Supertest

---

## 🏗️ Arquitetura

```
Frontend (React, repositório separado)
        │
        ▼
Backend (NestJS)  ──►  Stripe (fonte da verdade de billing)
        │
        ▼
PostgreSQL (Prisma)
```

Camadas: `controllers` (HTTP) → `services` (regra de negócio) → `modules`
(fronteira de domínio). Nenhuma lógica em controller.

### Multi-tenancy

A **clínica** é o tenant. Papéis:

| Papel       | `clinicId` | Escopo                                              |
| ----------- | ---------- | --------------------------------------------------- |
| `ADMIN`     | `null`     | plataforma; cruza clínicas só em endpoints ADMIN     |
| `OWNER`     | obrigatório| clínica inteira                                      |
| `DENTIST`   | obrigatório| própria agenda e próprios prontuários                |
| `ASSISTANT` | obrigatório| operação da clínica, sem dados financeiros/clínicos   |
| `PATIENT`   | `null`     | transitório, entre o cadastro Google e o onboarding   |

Guards globais, nesta ordem:
`Throttler → JwtAuth → Tenant → Roles → BillingAccess → PlanFeature`.

---

## 📁 Estrutura

```
src/
  common/      guards, decorators, filtros, políticas de acesso, utilitários
  config/      configuração e validação de ambiente
  modules/
    admin-finance/  ai-assistant/  appointments/  audit-log/  auth/
    billing/  calendar-integrations/  clinic/  clinical-records/
    finance/  fiscal/  health/  mail/  metrics/  notification/
    patients/  privacy/  profiles/  reports/  specialties/  stock/
    subscriptions/  users/
  prisma/      PrismaService
prisma/        schema, migrations, seeds
scripts/       utilitários de operação e qualidade
test/          harness HTTP, suporte de testes e specs e2e
```

---

## 🚀 Começando

```bash
bun install
cp .env.example .env          # preencha os valores
bunx prisma generate
bunx prisma migrate deploy
bun run start:dev
```

### Comandos

| Objetivo                    | Comando                    |
| --------------------------- | -------------------------- |
| Type check                  | `bun run typecheck`        |
| Lint (validação)            | `bun run lint:check`       |
| Testes unitários (sem banco)| `bun run test`             |
| Cobertura                   | `bun run test:cov`         |
| Subir o banco descartável   | `bun run test:db:up`       |
| Migrations do zero          | `bun run test:migrations`  |
| Integração (exige o banco)  | `bun run test:integration` |
| E2E (exige o banco)         | `bun run test:e2e`         |
| Derrubar o banco            | `bun run test:db:down`     |
| Código morto                | `bun run deadcode`         |
| Validar schema Prisma       | `bun run prisma:validate`  |
| Build                       | `bun run build`            |
| Tudo                        | `bun run verify`           |

> `bun run lint` executa `eslint --fix` e **reescreve arquivos**. Não use como
> validação — use `lint:check`.

### Deploy

```bash
bun install && bunx prisma generate && bun run build   # build
bunx prisma migrate deploy                             # migrações
bun run start:prod                                     # start
```

---

## 🧪 Testes

`bun run test` cobre dois níveis no mesmo runner e **nunca toca em banco**:
`test/jest-unit-setup.ts` fixa um ambiente falso e não lê o `.env`.

- **Unitários** — `*.spec.ts` ao lado do código.
- **Aplicação (HTTP)** — `*.http.spec.ts`, sobem o `AppModule` real via
  `test/support/http-harness.ts`: roteamento, `ValidationPipe`, guards e filtro
  de exceção reais, com o `PrismaService` substituído por um mock em memória.

Dois níveis exigem PostgreSQL de verdade:

- **Integração** — `test/integration/*.int-spec.ts` (`bun run test:integration`),
  a aplicação real sobre o banco real. É onde constraints, cascatas,
  transações, `Decimal`, `@db.Date` e concorrência são provados — nada disso um
  mock consegue demonstrar.
- **E2E** — `test/*.e2e-spec.ts` (`bun run test:e2e`), a aplicação exatamente
  como o `main.ts` a monta: headers de segurança, política de CORS, limites de
  corpo, prefixo de rota e o `ValidationPipe` global.

```bash
bun run test:db:up          # postgres:16-alpine descartável na porta 5433
bun run test:migrations     # aplica todo o histórico de migrations do zero
bun run test:integration
bun run test:e2e
bun run test:db:down        # derruba e apaga o volume
```

⚠️ **Nunca aponte esses testes para o `DATABASE_URL` de desenvolvimento** — ele
é uma instância Supabase compartilhada com dados reais. As duas suítes validam
a URL em `test/support/test-database.ts` e se recusam a rodar contra qualquer
coisa que não seja um banco local descartável (AGENTS.md §8).

Não há exceções na verificação de drift: `bun run test:migrations` exige que
as migrations e o `schema.prisma` coincidam exatamente. A tabela órfã
`website_leads`, resquício da captação pública de leads desativada em
2026-06-04, foi removida por `20260605000001_drop_orphaned_website_leads`
depois de confirmar por consulta somente-leitura que a produção não a possui
(AGENTS.md §8).

O schema de teste é aplicado com `prisma migrate deploy`, nunca com
`db push`. `db push` lê o `schema.prisma` e jamais abre `prisma/migrations`,
então não prova nada sobre o histórico — foi assim que uma cadeia quebrada
sobreviveu por meses. `bun run test:migrations` é a verificação: constrói um
banco descartável do zero com as migrations reais, compara o resultado com o
`schema.prisma` e reaplica as migrations corretivas sobre um banco já migrado
para provar que não são destrutivas. A CI executa esse mesmo comando.

Usar `migrate deploy` também dá às suítes o schema real: duas invariantes de
tenancy são SQL puro que o Prisma não consegue expressar (um único OWNER ativo
por clínica, e a checagem de papel × clínica), e o `db push` nunca as cria.
Detalhes em AGENTS.md §8.

Quatro suítes protegem invariantes de sistema inteiro e falham de propósito
quando um endpoint muda:

| Suíte                                    | Protege                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `route-access-matrix.spec.ts`             | a política declarada de todas as rotas                 |
| `authorization-enforcement.http.spec.ts`  | que essas políticas são de fato aplicadas              |
| `tenant-scoping.http.spec.ts`             | que toda query com escopo de clínica leva o predicado  |
| `cross-tenant-isolation.http.spec.ts`     | que a clínica A não lê nem altera dados da clínica B   |

---

## 💳 Stripe

O backend valida tudo; o cliente nunca é confiável. A Stripe é a fonte da
verdade de billing e chega via webhooks — assinatura verificada e eventos
deduplicados por id.

Em desenvolvimento a Stripe não alcança o servidor local. Use o Stripe CLI:

```bash
stripe listen --forward-to http://localhost:3000/api/billing/webhook
```

Copie o `whsec_...` impresso para `STRIPE_WEBHOOK_SECRET`. Sem isso,
`checkout.session.completed` e `customer.subscription.*` nunca chegam e a
assinatura fica em `incomplete`.

Para reconciliar uma assinatura que ficou fora de sincronia, veja
[`docs/ops/stripe-subscription-sync.md`](./docs/ops/stripe-subscription-sync.md).

---

## 📧 E-mail — Resend

```env
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
MAIL_FROM="DentalFlow <no-reply@seu-dominio.com>"
FRONTEND_URL=http://localhost:5173
```

Sem `RESEND_API_KEY` o backend usa um stub seguro: nenhum e-mail é enviado e o
link de redefinição é impresso no console.

```
[DEV] Password reset link: http://localhost:5173/recuperar-senha/redefinir?token=...
```

Em produção, se a chave faltar, o backend registra um aviso e responde
normalmente — a resposta genérica é preservada, sem revelar se o e-mail existe.

---

## 🔐 Segurança

- Access token JWT de 15 min no corpo da resposta, enviado via
  `Authorization: Bearer`.
- Refresh token opaco, com hash SHA-256 em repouso, em cookie `HttpOnly`
  limitado a `path=/api/auth`, rotacionado a cada uso e com detecção de reuso.
- Rotas autenticadas por cookie (`/auth/refresh`, `/auth/logout`) validam o
  `Origin` contra a allowlist, porque o cookie é `SameSite=None` em produção.

Detalhes em
[`docs/security/cross-site-auth-and-csrf.md`](./docs/security/cross-site-auth-and-csrf.md).

---

## ⚙️ Ambiente

`validateEnv()` roda no boot e falha rápido quando falta configuração,
listando tudo que está ausente de uma vez. Em produção exige adicionalmente
HTTPS em `FRONTEND_URL` e em todas as origens de `FRONTEND_ORIGIN` (curinga
`*` é rejeitado). Veja `.env.example`.

---

## 📌 Status

🚧 Em desenvolvimento ativo.

## Production hardening status

Current cross-repository findings, validated changes and release decision are in the frontend's [production-hardening report](../dentalflow-web/docs/deployment/production-hardening.md). The original audit remains historical; do not infer readiness from a green build alone. [File manifest](../dentalflow-web/docs/deployment/hardening-files.md).
