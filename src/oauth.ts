import { createHash, randomBytes } from "node:crypto";
import type express from "express";

/**
 * Claude's remote custom-connector flow requires a real OAuth 2.0 +
 * PKCE handshake (it probes /.well-known/oauth-authorization-server and
 * hits /authorize) - it won't accept a manually-configured static bearer
 * token for this connector type. Piano itself has no OAuth for its API keys,
 * so this implements just enough of an authorization server to satisfy that
 * handshake: /authorize renders a plain form where the employee pastes
 * their own Piano ACCESS_KEY/SECRET_KEY *once*, and the "access token"
 * Claude ends up storing and refreshing IS that "<ACCESS_KEY>_<SECRET_KEY>"
 * pair - the same value /mcp already expects in its Authorization header.
 * No credential is stored here beyond the few minutes of the handshake
 * itself.
 */

interface PendingFlow {
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  expiresAt: number;
}

interface IssuedCode {
  pianoKey: string;
  codeChallenge?: string;
  expiresAt: number;
}

const FLOW_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
// A year-scale "expiry" - the token is really the caller's own long-lived
// Piano key, not a token this server can meaningfully revoke or rotate.
const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

const flows = new Map<string, PendingFlow>();
const codes = new Map<string, IssuedCode>();

function purgeExpired<T extends { expiresAt: number }>(store: Map<string, T>): void {
  const now = Date.now();
  for (const [key, value] of store) {
    if (value.expiresAt < now) store.delete(key);
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function pkceMatches(verifier: string, challenge: string): boolean {
  return base64url(createHash("sha256").update(verifier).digest()) === challenge;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

// Only ever redirect back into claude.ai's own callback - this page collects
// a real Piano credential, so an attacker-controlled redirect_uri here would
// be a credential-phishing vector.
function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && (url.hostname === "claude.ai" || url.hostname.endsWith(".claude.ai"));
  } catch {
    return false;
  }
}

function baseUrl(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function renderAuthorizePage(flowId: string, error?: string): string {
  const errorHtml = error ? `<p class="error">${error}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect Piano Analytics</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input { width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; cursor: pointer; }
  .error { color: #b00020; }
  .hint { color: #555; font-size: 0.9rem; }
</style>
</head>
<body>
  <h1>Connect your Piano Analytics account</h1>
  <p class="hint">
    Enter your own personal Piano Analytics API keys, from
    <a href="https://analytics.piano.io/profile/#/apikeys" target="_blank" rel="noopener">your Piano profile</a>.
    They are sent directly to this server over HTTPS and are not stored beyond completing this connection.
  </p>
  ${errorHtml}
  <form method="POST" action="/authorize">
    <input type="hidden" name="flow_id" value="${flowId}">
    <label for="access_key">Access key</label>
    <input type="text" id="access_key" name="access_key" autocomplete="off" required>
    <label for="secret_key">Secret key</label>
    <input type="password" id="secret_key" name="secret_key" autocomplete="off" required>
    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
}

function tokenResponse(pianoKey: string) {
  return {
    access_token: pianoKey,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: pianoKey,
  };
}

export function registerOAuthRoutes(app: express.Express): void {
  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (req, res) => {
    const issuer = baseUrl(req);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    const issuer = baseUrl(req);
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    });
  });

  app.get("/authorize", (req, res) => {
    purgeExpired(flows);
    const { response_type, redirect_uri, code_challenge, code_challenge_method, state } = req.query;

    if (response_type !== "code" || typeof redirect_uri !== "string" || !isAllowedRedirect(redirect_uri)) {
      res.status(400).send("Invalid or disallowed authorization request.");
      return;
    }
    if (code_challenge_method !== undefined && code_challenge_method !== "S256") {
      res.status(400).send("Only PKCE with S256 is supported.");
      return;
    }

    const flowId = randomToken();
    flows.set(flowId, {
      redirectUri: redirect_uri,
      state: typeof state === "string" ? state : "",
      codeChallenge: typeof code_challenge === "string" ? code_challenge : undefined,
      expiresAt: Date.now() + FLOW_TTL_MS,
    });
    res.type("html").send(renderAuthorizePage(flowId));
  });

  app.post("/authorize", (req, res) => {
    purgeExpired(flows);
    const { flow_id, access_key, secret_key } = req.body ?? {};
    const flow = typeof flow_id === "string" ? flows.get(flow_id) : undefined;
    if (!flow) {
      res.status(400).send("This authorization request has expired - please reconnect from Claude.");
      return;
    }

    const accessKey = typeof access_key === "string" ? access_key.trim() : "";
    const secretKey = typeof secret_key === "string" ? secret_key.trim() : "";
    if (!accessKey || !secretKey) {
      res.type("html").send(renderAuthorizePage(flow_id, "Both keys are required."));
      return;
    }
    flows.delete(flow_id);

    purgeExpired(codes);
    const code = randomToken();
    codes.set(code, {
      pianoKey: `${accessKey}_${secretKey}`,
      codeChallenge: flow.codeChallenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(flow.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (flow.state) redirectUrl.searchParams.set("state", flow.state);
    res.redirect(302, redirectUrl.toString());
  });

  app.post("/token", (req, res) => {
    const body = req.body ?? {};

    if (body.grant_type === "authorization_code") {
      purgeExpired(codes);
      const code = body.code;
      const entry = typeof code === "string" ? codes.get(code) : undefined;
      if (!entry) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      codes.delete(code); // single use

      if (entry.codeChallenge) {
        const verifier = body.code_verifier;
        if (typeof verifier !== "string" || !pkceMatches(verifier, entry.codeChallenge)) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }
      res.json(tokenResponse(entry.pianoKey));
      return;
    }

    if (body.grant_type === "refresh_token") {
      // The "refresh token" is the caller's own Piano key pair - nothing to
      // rotate server-side, so refreshing just re-issues the same value.
      const refreshToken = body.refresh_token;
      if (typeof refreshToken !== "string" || !refreshToken.includes("_")) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      res.json(tokenResponse(refreshToken));
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });
}
