import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { getPianoClient } from "./pianoClient.js";

const app = express();
app.use(express.json());

const BEARER_PREFIX = "Bearer ";

/**
 * Each caller sends their own Piano "<ACCESS_KEY>_<SECRET_KEY>" pair as
 * their personal connector auth token - this wrapper holds no shared Piano
 * credential of its own, so a request without one has nothing to relay
 * upstream with. Returns null (after responding 401) if missing.
 */
function extractPianoKey(req: express.Request, res: express.Response): string | null {
  const header = req.header("authorization");
  if (!header?.startsWith(BEARER_PREFIX)) {
    res.status(401).json({
      error: "unauthorized",
      detail: "Send your Piano key pair as 'Authorization: Bearer <ACCESS_KEY>_<SECRET_KEY>'.",
    });
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

/**
 * Builds a fresh proxy server for a single request. Every handler just
 * forwards to this caller's own Piano client and relays the result
 * verbatim - this wrapper adds no tools/logic of its own, only the
 * per-caller credential passthrough.
 */
function buildProxyServer(pianoKey: string): Server {
  const server = new Server(
    { name: "custom-piano-mcp-wrapper", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const piano = await getPianoClient(pianoKey);
    return piano.listTools(request.params);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const piano = await getPianoClient(pianoKey);
    return piano.callTool(request.params);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const piano = await getPianoClient(pianoKey);
    return piano.listResources(request.params);
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const piano = await getPianoClient(pianoKey);
    return piano.readResource(request.params);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const piano = await getPianoClient(pianoKey);
    return piano.listPrompts(request.params);
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const piano = await getPianoClient(pianoKey);
    return piano.getPrompt(request.params);
  });

  return server;
}

// Stateless mode: one Server + Transport per request, torn down when the
// response ends. Simple, and fine here since the only shared state is the
// single upstream Piano connection (see pianoClient.ts), not per-session data.
app.post("/mcp", async (req, res) => {
  const pianoKey = extractPianoKey(req, res);
  if (!pianoKey) return;
  try {
    const server = buildProxyServer(pianoKey);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error" });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "method_not_allowed", detail: "This wrapper is stateless; only POST /mcp is supported." });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.listen(config.wrapper.port, () => {
  console.log(`Piano MCP wrapper listening on port ${config.wrapper.port}`);
});
