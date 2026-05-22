# 🦷 DentalFlow — Backend

Este repositório contém o backend da plataforma DentalFlow, um SaaS para dentistas focado em crescimento, presença digital e geração de pacientes.

---

# 🧠 Visão Geral

Backend responsável por:
- autenticação
- regras de negócio
- integração Stripe
- persistência de dados
- API para frontend

---

# ⚙️ Stack

- Node.js
- NestJS
- TypeScript
- Prisma ORM
- PostgreSQL
- Stripe

---

# 🏗️ Arquitetura

Frontend (React)
↓
Backend (NestJS)
↓
PostgreSQL
↓
Stripe

---

# 📁 Estrutura

src/
  modules/
    auth/
    users/
    profiles/
    leads/
    subscriptions/
    billing/
    metrics/
  common/
  prisma/
  config/

---

# ✅ RF

- cadastro de usuário
- autenticação JWT
- gestão de perfil
- gestão de leads
- assinatura
- integração Stripe

---

# ⚠️ RNF

- escalável
- seguro
- tipado
- modular
- performático

---

# 💳 Stripe

- source of truth para billing
- usar webhooks
- validar backend

## Desenvolvimento local — webhook forwarding

Em ambiente local o Stripe não consegue entregar eventos ao servidor. Para testar o fluxo de assinatura (checkout, ativação, cancelamento) é necessário o Stripe CLI:

```bash
stripe listen --forward-to http://localhost:3000/api/billing/webhook
```

O comando imprime um webhook signing secret temporário (`whsec_...`). Copie o valor e defina em `.env`:

```
STRIPE_WEBHOOK_SECRET=whsec_<valor gerado pelo stripe listen>
```

Sem este passo, `checkout.session.completed` e `customer.subscription.*` nunca chegam ao backend e a assinatura permanece com status `incomplete`.

---

# 📌 Status

🚧 Em desenvolvimento

# Session Startup — DentalFlow Brain

At the start of every session, read these files from the Obsidian vault:

D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Next Step.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Roadmap Master.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Database Schema.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Backend Analysis.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Architecture Patterns.md

After reading, tell Pedro what to implement this session and ask: "Shall I start inspecting the code?"