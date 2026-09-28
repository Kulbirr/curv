# Vanity mint pool — instant launch

pump.fun-style instant launch: the "...curv" mint keypair is **not** ground
at click time. A background grinder keeps a pool of pre-ground keypairs;
`POST /api/vanity-mint` hands one out atomically per launch. When the pool
is dry or unreachable, the launch wizard falls back to its local
background grind, then to a random mint. A launch is never blocked by the
pool.

## Components

- `scripts/grind-pool.ts` — continuous grinder. `npm run grind`.
- `src/lib/db/vanity-pool.ts` — pool store (atomic exactly-once claim).
- `src/lib/vanity-crypto.ts` — AES-256-GCM at-rest encryption.
- `src/pages/api/vanity-mint.ts` — handout endpoint (5/hour per IP).
- `src/lib/vanity-handout.ts` — client fetch helper (null on any failure).
- `src/pages/create-pool.tsx` — tries the handout at wizard start, then
  the local grind.

## Setup

```bash
# 1. Generate the pool encryption key (do this once, keep it secret)
openssl rand -hex 32
# 2. Export it in the environment that runs the API server AND the grinder
export VANITY_POOL_KEY=<64 hex chars>
# 3. Start the grinder (background it with systemd/pm2/tmux in production)
npm run grind
```

Without `VANITY_POOL_KEY` both the grinder and the handout endpoint fail
closed with a clear error — nothing runs half-encrypted.

## Ops

```bash
# Pool health: ready vs handed-out
sqlite3 data/stockcurve.db \
  "SELECT SUM(consumed=0) AS ready, SUM(consumed=1) AS consumed FROM vanity_pool;"

# Top up faster: raise the target (grinder picks it up on next check)
VANITY_POOL_TARGET=200 npm run grind
```

- The grinder is idempotent: kill and restart any time, it tops up what is
  missing. Zero network I/O, never touches the chain.
- systemd sketch: `ExecStart=/usr/bin/npm run grind`,
  `WorkingDirectory=/opt/curv/app`, `EnvironmentFile=/etc/curv/vanity.env`
  (mode 600, holding `VANITY_POOL_KEY`), `Restart=always`.
- `data/` is gitignored — the pool DB never enters version control.

## Trust model (read this before production)

1. **The server generates and briefly holds single-use mint keypairs.**
   Each handed keypair is used exactly once: it partial-signs the pool
   creation transaction and is wiped from the pool row at handout.
2. **A mint keypair's power is essentially spent the moment the pool is
   created.** Mint authority and freeze authority are assigned separately
   at creation; the mint keypair itself authorizes (almost) nothing
   afterwards. A compromised pool entry is near-worthless after its one
   use — this is why the pre-ground model is acceptable, unlike pooling
   wallet keys, which would be catastrophic.
3. **Secrets are encrypted at rest** (AES-256-GCM, fresh IV per row) and
   wiped (set to NULL) in the same transaction that marks the row
   consumed. A stolen DB file without the key yields nothing.
4. **What this is NOT:** it is not proof of origin. The "...curv" suffix
   is cosmetic and unenforceable — anyone can grind one without using us,
   exactly like "...pump". The verified listing (field-by-field on-chain
   check) remains the actual proof a coin launched here.
5. **Production hardening still wanted:** serve only over HTTPS, move
   `VANITY_POOL_KEY` from env into a KMS/HSM, and consider encrypting
   handouts to the claimer's wallet (X25519 sealed box) so the server
   cannot read a keypair after generating it.
