# Reconciliação de assinatura Stripe

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
