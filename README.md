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

# 📧 Email — Resend

O DentalFlow usa o [Resend](https://resend.com) para envio de e-mails transacionais (ex: redefinição de senha).

## Configuração

Defina as variáveis abaixo no seu `.env`:

```env
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
MAIL_FROM="DentalFlow <no-reply@seu-dominio.com>"
FRONTEND_URL=http://localhost:5173
```

- **`RESEND_API_KEY`** — Chave da API obtida em [resend.com/api-keys](https://resend.com/api-keys). Obrigatório para envio real.
- **`MAIL_FROM`** — Endereço remetente verificado no painel do Resend. Obrigatório quando `RESEND_API_KEY` está definido.
- **`FRONTEND_URL`** — URL base do frontend, usada para montar o link de redefinição de senha nos e-mails. Obrigatório em produção (deve usar HTTPS).

## Desenvolvimento local

Sem `RESEND_API_KEY`, o backend usa um stub seguro: em vez de enviar e-mail, **loga o link completo de redefinição no console**. Nenhum e-mail é enviado.

```
[DEV] Password reset link: http://localhost:5173/recuperar-senha/redefinir?token=...
```

Copie o link e acesse diretamente no navegador para testar o fluxo de recuperação de senha localmente.

Em produção, se `RESEND_API_KEY` estiver ausente, o backend loga um aviso e responde normalmente ao frontend (resposta genérica preservada — sem exposição de existência de e-mail).

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