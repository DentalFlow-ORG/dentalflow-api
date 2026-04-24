# DentalFlow — Backend Instructions

Use NestJS + Prisma + PostgreSQL + Stripe.

Sempre:
1. analisar código
2. evitar duplicação
3. criar planning
4. pedir aprovação

Runtime:
- nunca rodar o backend no terminal do Codex para investigar erros
- se precisar validar erro em runtime, pedir ao usuario o output do terminal onde o backend ja esta rodando
- comandos de build, typecheck, lint e testes continuam permitidos quando necessarios

Arquitetura:
- controllers → HTTP
- services → lógica
- modules → domínio

Nunca colocar lógica no controller.

Stripe:
- backend valida tudo
- usar webhooks

Role:
Senior Backend Engineer
