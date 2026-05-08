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

# Session Startup — DentalFlow Brain

At the start of every session, read these files from the Obsidian vault:

D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Next Step.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Roadmap Master.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Database Schema.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Backend Analysis.md
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\DentalFlow — Architecture Patterns.md

After reading, tell Pedro what to implement this session and ask: "Shall I start inspecting the code?"