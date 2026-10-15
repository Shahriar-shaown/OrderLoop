# OrderLoop

One loop. Every order. Bangladesh-first order, courier, COD and inventory management for Facebook and Instagram sellers.

- Plan: [docs/implementation-plan.md](docs/implementation-plan.md)
- Architecture: [docs/architecture.md](docs/architecture.md)

## Quick start

Requires Node 22, Docker Desktop, and pnpm (via corepack).

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm services:up      # postgres (localhost:5433), redis, mailpit
pnpm dev              # api :4000, worker, web :3000, expo
```

Checks: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus `pnpm check:versions` and `pnpm check:boundaries`.
