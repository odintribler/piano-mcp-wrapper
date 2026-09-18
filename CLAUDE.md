# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A thin MCP proxy: Claude Enterprise connects to this wrapper as a single
custom connector, and the wrapper forwards every request verbatim to
Piano.io's remote MCP server. It holds no Piano credential of its own —
each caller sends their own personal Piano key pair per request, which the
wrapper passes upstream unchanged. This is deliberate: Piano's API keys are
personal and encode the caller's own default site, so different employees
must get different results (see "Auth model" below). The wrapper adds no
tools, resources, or prompts of its own — it only relays `tools/*`,
`resources/*`, and `prompts/*` calls.

## Commands

```bash
npm install
cp .env.example .env   # then fill in PIANO_MCP_URL, etc. - no credentials go here
npm run build           # tsc -p tsconfig.json -> dist/
npm start                # node dist/index.js (runs the build output)
npm run dev              # tsx src/index.ts, no build step, for local iteration
```

There is no test suite or linter configured in this repo.

## Architecture

Three files carry all the logic:

- `src/config.ts` — reads and validates env vars into a single `config`
  object. `required()` throws immediately at startup if a required var
  (`PIANO_MCP_URL`) is missing, so config errors surface before the server
  starts accepting requests rather than on first request. Notably, no Piano
  credential lives here — see "Auth model".
- `src/pianoClient.ts` — owns the upstream MCP client connections to Piano,
  one per distinct caller key pair. `getPianoClient(pianoKey)` lazily
  creates and caches a `Client` per key in the module-level `clients` Map;
  `client.onclose` deletes that entry so the next call with the same key
  reconnects instead of reusing a dead connection. Connections are never
  shared across different key pairs — that's what keeps each employee's
  calls scoped to their own Piano identity/site.
- `src/index.ts` — the downstream Express server exposing `POST /mcp`. It is
  **stateless by design**: each request builds a fresh `Server` +
  `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`), torn
  down on `res.close`. `extractPianoKey()` pulls the caller's key pair out
  of the incoming `Authorization: Bearer <key>` header (401 if absent) and
  threads it through `buildProxyServer(pianoKey)` into every MCP request
  handler (`ListTools`, `CallTool`, `ListResources`, `ReadResource`,
  `ListPrompts`, `GetPrompt`), each of which just fetches that caller's
  Piano client and forwards `request.params`/the result untouched.

### Auth model

There is a single hop, not two: the value each caller sends as
`Authorization: Bearer <ACCESS_KEY>_<SECRET_KEY>` on the downstream request
*is* their own personal Piano credential (from
https://analytics.piano.io/profile/#/apikeys), forwarded unchanged as
Piano's `x-api-key` header on the upstream request (`authHeaders()` in
`pianoClient.ts`, format per https://docs.piano.io/en/analytics/mcp). The
wrapper never stores or centralizes a credential — it's pure passthrough,
per request. Anyone who can reach `POST /mcp` with a valid Piano key pair
gets exactly what that key pair is entitled to, no more and no less; there
is no additional wrapper-level access control layered on top.

`PIANO_MCP_TRANSPORT` selects between `streamable-http` (default) and `sse`
(legacy fallback) for the upstream connection only; the downstream side is
always Streamable HTTP.

## Working in this repo

- Keep the "no logic of its own" invariant: this wrapper's job is relaying
  calls and passing through each caller's own credential, not interpreting
  or modifying MCP payloads, and not centralizing/storing any Piano
  credential server-side. If a change starts adding request/response
  transformation or a shared credential, that's a signal to reconsider
  whether it belongs here.
- Never put real values in `.env.example`; only `.env` (gitignored) holds
  local config, and it should never need a real Piano credential given the
  per-request passthrough model above.
