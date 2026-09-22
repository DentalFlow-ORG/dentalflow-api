# Reconciliação de assinatura Stripe

> **Before releasing any change to checkout, the portal or subscription
> state**, work through the Stripe test-mode QA checklist in
> [AGENTS.md §9](../../AGENTS.md#9-stripe). No automated test reaches the
> Stripe API — the harnesses stub outbound `fetch` so that none can — so that
> checklist is the only thing standing between a billing regression and a
> customer.

Use este procedimento quando a Stripe já mostra uma assinatura paga/ativa, mas o DentalFlow local ainda mostra `INCOMPLETE` ou acesso bloqueado.

Casos comuns:

- o webhook local não estava rodando ou não estava encaminhado pelo Stripe CLI;
- `STRIPE_WEBHOOK_SECRET` estava ausente ou divergente;
- o checkout redirecionou antes do webhook terminar;
- uma assinatura antiga foi criada antes da sincronização por `checkout_session_id`.

O script consulta a Stripe como fonte de verdade, valida a clínica local associada e só então atualiza a assinatura local. Ele não deve ser usado para simular pagamento ou forçar status manualmente.

## Dry run

```bash
bunx ts-node -r tsconfig-paths/register scripts/ops/sync-stripe-subscription.ts --email "clinica@example.com" --dry-run
```

## Aplicar reconciliação

```bash
bunx ts-node -r tsconfig-paths/register scripts/ops/sync-stripe-subscription.ts --email "clinica@example.com"
```

Também é possível selecionar por:

```bash
bunx ts-node -r tsconfig-paths/register scripts/ops/sync-stripe-subscription.ts --stripe-customer-id "cus_..." --dry-run
bunx ts-node -r tsconfig-paths/register scripts/ops/sync-stripe-subscription.ts --stripe-subscription-id "sub_..." --dry-run
bunx ts-node -r tsconfig-paths/register scripts/ops/sync-stripe-subscription.ts --clinic-id "..." --dry-run
```

Se houver ambiguidade entre cliente Stripe, assinatura e clínica local, o script interrompe a execução e pede um seletor mais específico.

## Hardening follow-up

Webhook failures now return 503, and local event/subscription/item writes share a PostgreSQL transaction/advisory lock. Update/invoice events retrieve current Stripe state. This does not certify every checkout ordering case: parallel active checkouts and historical checkout metadata still require explicit reconciliation tests and the test-mode checklist above. See the canonical [hardening report](../../../dentalflow-web/docs/deployment/production-hardening.md) before approving a release. Do not force local ACTIVE status to bypass a provider failure.
