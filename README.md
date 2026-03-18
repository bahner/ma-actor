# ma-actor

A WebAssembly actor client built on top of `did-ma`.

It creates/unlocks local encrypted identity bundles, publishes DID documents to IPNS via Kubo, and provides a command-driven browser UI.

## Features

- WASM exports for identity lifecycle
  - create identity
  - create identity bound to existing IPNS key
  - unlock encrypted identity bundle
- Passphrase-based local encryption (`argon2id` + `XChaCha20Poly1305`)
- BIP39 recovery phrase generation/normalization
- Browser UI with slash commands
- Kubo API integration for key management and IPNS publish

## Repository Layout

- `src/lib.rs`: wasm-bindgen exports and crypto/identity logic
- `www/index.html`: UI shell
- `www/style.css`: UI styling
- `www/app.js`: app logic and slash command handling
- `www/pkg/`: generated wasm-pack output (ignored)

## Prerequisites

- Rust toolchain
- `wasm-pack`
- Python 3 (for local static server)
- Kubo/IPFS API reachable at `http://127.0.0.1:5001`

## Build and Run

```bash
make build
make serve
```

The app is served on:

- `http://127.0.0.1:8081`

## Cleanup

```bash
make clean
make distclean
```

## Slash Commands

- `/help`
- `/identity`
- `/alias <name> <address>`
- `/unalias <name>`
- `/aliases`
- `/publish` (publishes DID document to IPNS)

## Identity and Publish Model

- Encrypted bundle is local/private (browser storage + export file)
- DID document is public and publishable
- `/publish` uploads DID document JSON to IPFS and updates IPNS record

## Kubo CORS

Browser calls require Kubo API CORS headers allowing your app origin (for example `http://127.0.0.1:8081`).

If `/publish` or Kubo check fails in-browser, verify:

1. Kubo daemon is running
2. API endpoint is correct
3. CORS origins include your host/port

