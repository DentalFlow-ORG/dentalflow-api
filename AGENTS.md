# DentalFlow — Backend Instructions

Use NestJS + Prisma + PostgreSQL + Stripe.

## Package Manager

This project uses **Bun**. Use `bun` for all package management and script execution.

```
bun install               # install dependencies
bun run <script>          # run a package.json script
bun add <pkg>             # add a dependency
bun remove <pkg>          # remove a dependency
bunx prisma generate      # run Prisma CLI commands
bunx prisma migrate deploy
bunx ts-node <script>     # run one-off TypeScript scripts
```

Do not use `pnpm`, `npm`, or `yarn`. If a command fails with Bun, fix the script — do not fall back to another package manager.

## Validation Sequence

Run in this order after any TypeScript or logic change:

```
bun run typecheck
bun run test
bun run build
```

## Deployment Commands

Build:

```
bun install && bunx prisma generate && bun run build
```

Start (production):

```
bun run start:prod
```

Migrations (when deploying schema changes):

```
bunx prisma migrate deploy
```

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
