# ma-home

A WebAssembly home client built on top of `did-ma`.

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
make publish-ipfs
```

The app is served on:

- `http://127.0.0.1:8081`

The build can also be published to IPFS as a static artifact:

- `make publish-ipfs`
- Prints the root CID plus local and public gateway URLs for the built `www/` directory
- Intended for distribution and archival; local serving remains the recommended runtime origin

## Cleanup

```bash
make clean
make distclean
```

## Slash Commands

- `/help`
- `/identity`
- `/alias <name> <address>`
- `alias <name> <address>`
- `/unalias <name>`
- `/aliases`
- `/enter </iroh/...|alias>`
- `/publish` (publishes DID document to IPNS)

## Home Entry Over Iroh

You can save a world alias using an advertised Iroh endpoint id and then enter it:

```text
alias home /iroh/bf19268b811bbee577021f97f90d08bd752921c1f7d98a3b00a9900a261790bc
/enter home
```

Current behavior:

- The browser WASM client uses `iroh` directly
- `/enter` accepts either a literal `/iroh/<endpoint-id>` value or an alias to one
- The client opens an Iroh connection to `ma-world` over the world protocol ALPN
- Plain chat text after `/enter` is sent to the current world and room
- Room chatter is fanned out by `ma-world` and polled by each avatar, so all connected avatars in the room receive the same speech events

The localhost status page in `ma-world` is still useful for inspection, but it is no longer the transport path for `/enter`.

## Identity and Publish Model

- Encrypted bundle is local/private (browser storage + export file)
- DID document is public and publishable
- `/publish` uploads DID document JSON to IPFS and updates IPNS record
- Browser storage is namespaced per alias, so one browser profile can keep multiple local homes
- The currently active alias is remembered per browser tab, which allows concurrent homes in separate tabs/windows on the same origin
- The actor locale is configurable per alias; localized `@` aliases are mapped to canonical protocol targets before sending
- The published DID document carries the preferred locale in `ma:locale` using canonical locale tags such as `en` and `nb-NO`

## Kubo CORS

Browser calls require Kubo API CORS headers allowing your app origin (for example `http://127.0.0.1:8081`).

If `/publish` or Kubo check fails in-browser, verify:

1. Kubo daemon is running
2. API endpoint is correct
3. CORS origins include your host/port

Local serving on `http://127.0.0.1:8081` remains the recommended runtime origin.
Use `make publish-ipfs` for distribution and archival, not as the primary runtime origin.

