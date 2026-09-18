# custom-piano-mcp

A thin wrapper MCP server that sits between Claude Enterprise and Piano.io's
remote MCP server. It re-exposes Piano's tools/resources/prompts as-is and
relays each employee's own personal Piano API key through per request - so
employees connect to this wrapper's URL as a single custom connector, but
each still gets their own Piano identity (and default site) on every call.

## How it works

- Downstream (Claude Enterprise → this wrapper): a stateless MCP server over
  Streamable HTTP at `POST /mcp`. Every request must carry the caller's own
  Piano key pair as `Authorization: Bearer <ACCESS_KEY>_<SECRET_KEY>` - the
  same personal keys from https://analytics.piano.io/profile/#/apikeys that
  Piano itself expects (per
  [Piano's MCP docs](https://docs.piano.io/en/analytics/mcp)). This is what
  makes results reflect that employee's own default site, instead of one
  shared site for everyone.
- Upstream (this wrapper → Piano.io): for each caller's key pair, an MCP
  client connection to Piano's remote MCP endpoint, sending that same value
  on as Piano's `x-api-key` header. One connection is cached per distinct
  key pair, so repeat calls from the same employee reuse it, but different
  employees never share a connection. Every `tools/list`, `tools/call`,
  `resources/*` and `prompts/*` request is forwarded verbatim and the
  result relayed back - the wrapper adds no tools or logic of its own, and
  holds no Piano credential of its own.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set PIANO_MCP_URL (and PORT if you don't want the default)
npm run build
npm start
```

For local iteration without a build step: `npm run dev`.

There is no shared Piano credential to configure in `.env` - it only holds
the upstream endpoint/transport and this wrapper's own port. Each caller
supplies their own Piano key pair per request (see "How it works" above).
To test locally, send your own key pair yourself:

```bash
curl -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <YOUR_ACCESS_KEY>_<YOUR_SECRET_KEY>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Never put real values in `.env.example` or anywhere tracked by git.

## Deploying so all employees can reach it

This only helps if it's reachable at one stable URL that every employee's
Claude Enterprise custom connector can hit:

1. Run it on a server your org controls (a small VM, container, etc.),
   behind HTTPS — Claude Enterprise's remote connector setup requires TLS.
2. Put a reverse proxy (nginx/Caddy/etc.) in front of Node for TLS
   termination, forwarding to this app's `PORT`.
3. In Claude Enterprise's admin settings, add a custom MCP connector
   pointing at `https://<your-domain>/mcp`, configured so each employee
   enters their own bearer token when they personally connect it. Each
   employee's token is their own Piano `<ACCESS_KEY>_<SECRET_KEY>` pair from
   their own profile - not a value the org admin configures once for
   everyone.
4. This server's `.env` never needs a real Piano credential, since there's
   no org-wide secret to protect anymore - only the endpoint config.

## Notes

- Because each request carries its own key pair, there's no org-wide secret
  to leak, but the wrapper is now only as safe as Piano's own key scoping -
  anyone holding a valid Piano key pair can use it through the wrapper
  exactly as they could directly against Piano.
- `PIANO_MCP_TRANSPORT=sse` is available as a fallback if Piano's server
  turns out to speak the older SSE transport instead of Streamable HTTP.
