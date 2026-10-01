# One-Tap Trading via Session Keys — Design Spec

**Status:** Draft for review, 2026-10-01
**Goal:** Let users trade (buy/sell) without a wallet signature on every transaction, WITHOUT Curv ever taking custody of funds.

## 1. Problem

Every buy and sell on Curv today requires a wallet signature (`signTransaction` in `TradePanel.execute()`).
On desktop this is a popup; on Android via Mobile Wallet Adapter it is a slow app-switch to Phantom
and back, and an abandoned prompt strands the page (mitigated with a 120s timeout, but the friction
remains). Users reasonably ask: "can't I just keep a balance with you and tap to trade?"

## 2. Decision: session keys, not custody

Taking deposits into Curv-controlled accounts would make Curv a custodian: money-transmitter
exposure, a hot vault that becomes the project's #1 attack target, and a trust model ("trust us
with your money") that contradicts the non-custodial Meteora DBC positioning. One exploit ends
the project.

Session keys deliver the same UX — fund once, then tap-to-trade with zero prompts — while funds
stay in accounts whose private key is generated on the user's device and never leaves it.
Curv's servers never see the key and cannot move the money.

## 3. Design

### 3.1 Core concepts

- **Session keypair**: a fresh Ed25519 keypair generated in the browser (`Keypair.generate()`).
  Its address is the user's **trading balance** account.
- **Trading balance**: SOL and token ATAs owned outright by the session address. The session key
  IS the owner, so no SPL `approve` delegates are needed — it can sign for its own accounts.
- **Funding (one signature)**: the user signs exactly one transaction transferring SOL (and
  optionally tokens) from their main wallet to the session address. ATAs are created in the
  same transaction where needed.
- **One-tap trades (zero signatures)**: `TradePanel.execute()` builds the DBC swap with
  `owner = sessionKey.publicKey, payer = sessionKey.publicKey` and signs locally with the
  session secret key via `tx.sign(sessionKeypair)`. No wallet adapter involved, so no MWA
  app-switch on Android — signing is pure JS (tweetnacl), instant.
- **Cap**: user-chosen max SOL per session (e.g. 0.5 / 1 / 2 SOL presets + custom). Enforced in
  UI; the real enforcement is that only the funded amount exists at the session address.
- **Expiry**: user-chosen (24h / 7d / 30d). After expiry the app stops using the key and
  prompts to withdraw or renew. The app CAN auto-sweep funds back on expiry because the key
  is available locally — do it, don't strand funds.
- **Withdraw (zero signatures)**: transfer from the session address back to the main wallet,
  signed locally by the session key. No wallet prompt needed.

### 3.2 Key storage

The session secret key must survive page reloads but never sit in plaintext.

- Derive an AES-GCM key from a user-chosen 6-digit PIN via PBKDF2 (100k+ iterations, random salt).
- Store `{ encryptedSecret, salt, iv, expiry, capLamports, sessionAddress }` in localStorage.
- Keep the decrypted keypair in memory only, for the tab lifetime.
- **Lost PIN = funds locked.** Mitigations: show this warning plainly at setup; keep caps small
  by default; offer "email myself a reminder" is OUT of scope (no PII collection). Alternative
  considered: non-extractable WebCrypto key (no PIN, bound to browser profile) — rejected for v1
  because it cannot survive profile loss either and adds complexity; revisit if users hate PINs.

### 3.3 Threat model (be honest in UI copy)

- The session key lives in the same JS context as the app: an XSS compromise could exfiltrate it.
  Mitigations: the CSP shipped 2026-10-01 (no third-party scripts), caps, expiry. This is WHY
  caps exist — say so in the UI: "Only keep trading money here."
- Device compromise = session funds at risk, main wallet NEVER at risk (its key is never in the page).
- Curv server compromise = attacker gets zero keys; the worst they can do is serve a malicious
  frontend build — which is why Vercel deploy provenance and the CSP matter.
- A malicious session key cannot touch the main wallet. Ever. This is the whole point.

### 3.4 UX flow

1. Trade panel shows a "One-tap trading" toggle / lightning button next to the wallet button.
2. Setup modal: "Keep a small trading balance for instant trades." → amount presets →
   expiry select → PIN entry (twice) → one wallet signature to fund.
3. Panel header then shows two balances: **Trading** (session) and **Wallet** (main), with a
   "Top up" and "Withdraw" affordance.
4. Buy/sell with sufficient trading balance: button reads "Buy instantly" — tap, no prompt,
   status goes quoting → sending → confirmed (the "signing" step disappears).
5. Insufficient trading balance: fall back to the normal wallet-signature flow, with a one-tap
   "top up" nudge.
6. Sells: if the session account doesn't hold the token, offer "move tokens to trading
   balance" (one signature), then instant sells afterwards.
7. Manage screen: show cap, expiry countdown, "Withdraw all" (no signature), "Revoke"
   (withdraw + delete key = one tap, no signature needed since the session key signs the
   sweep itself).

## 4. Implementation plan

No new Solana program required. All client-side + existing DBC SDK.

**New: `src/lib/session-keys.ts`**
- `generateSessionKey()` → Keypair
- `encryptSessionKey(secret, pin)` / `decryptSessionKey(blob, pin)` (PBKDF2 + AES-GCM via WebCrypto)
- `saveSession(meta)` / `loadSession()` / `clearSession()` (localStorage)
- `buildFundTransaction({ from, sessionAddress, lamports, mints[] })` — SystemProgram.transfer
  + `createAssociatedTokenAccountInstruction` per mint, single tx
- `buildWithdrawTransaction({ sessionKeypair, to, mints[] })` — sweep SOL + tokens

**Modify: `src/components/Pool/TradePanel.tsx`**
- In `execute()`: if an active, unexpired session covers the trade, set
  `owner`/`payer`/`feePayer` to the session pubkey and `tx.sign(sessionKeypair)` instead of
  `withSignTimeout(signTransaction(tx))`. Everything downstream (sendRawTransaction, polling,
  invalidation) is unchanged.
- Balance display: add trading-balance alongside wallet balance.

**New UI: `src/components/Pool/SessionSetupModal.tsx`**, plus a small manage popover.

**Tests** (follow existing patterns in `src/lib/*.test.ts`):
- PIN encrypt/decrypt round-trip, wrong PIN fails
- Fund tx contains the transfer + ATA creations
- `execute()` uses the session path when active, wallet path otherwise
- Expired session is refused and triggers the sweep prompt

**Do NOT build in v1:** on-chain program-enforced limits, social recovery, passkey-bound
sessions, auto top-ups. Revisit after real usage.

## 5. Edge cases

- **User clears site data / new device**: session blob is gone; funds sit at the session address
  with no key. Mitigation: at setup, show the session public address and advise that the PIN is
  the only way back; keep default caps small (≤0.5 SOL) so the blast radius is bounded.
- **MWA/Android**: session signing bypasses the wallet adapter entirely — this also fixes the
  "Incorrect mode" class of issues for repeat trades.
- **Rent**: session SOL account needs rent-exempt minimum; disclose that ~0.001 SOL stays
  dust unless swept with account closure (use `SystemProgram.transfer` of full balance which
  closes it implicitly on zero — actually closing requires the full-balance transfer; handle it).
- **Devnet/mainnet**: session addresses are network-specific only in that funds live on one
  cluster; the mechanism is identical. Mark sessions per-cluster in storage.

## 6. Effort estimate

2–4 focused days for v1: key-management lib + setup modal + TradePanel integration + withdraw +
tests. No program deployment, no audit surface beyond the client lib. The expensive part is
getting the UX copy and edge cases right, not the cryptography.

## 7. Open questions for the user

1. Default cap: 0.5 SOL too small / too big?
2. Should expiry auto-sweep, or prompt first? (Recommend: auto-sweep with a clear notice.)
3. PIN vs "remember this device" (non-extractable key, no PIN)? Recommend PIN for v1.
