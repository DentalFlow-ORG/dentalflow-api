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

---

# 📌 Status

🚧 Em desenvolvimento
