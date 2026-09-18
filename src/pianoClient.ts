import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config } from "./config.js";

function authHeaders(pianoKey: string): Record<string, string> {
  // pianoKey is the caller's own "<ACCESS_KEY>_<SECRET_KEY>" pair, forwarded as-is -
  // see https://docs.piano.io/en/analytics/mcp
  return { "x-api-key": pianoKey };
}

// One upstream connection per distinct Piano key pair, so different callers
// (different default sites) never share a connection, but repeat calls from
// the same caller reuse theirs.
const clients = new Map<string, Promise<Client>>();

async function connect(pianoKey: string): Promise<Client> {
  const client = new Client({ name: "custom-piano-mcp-wrapper", version: "1.0.0" }, { capabilities: {} });
  const url = new URL(config.piano.url);
  const requestInit: RequestInit = { headers: authHeaders(pianoKey) };

  const transport = config.piano.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });

  client.onclose = () => {
    // Drop the cached connection so the next call with this key reconnects instead of reusing a dead client.
    clients.delete(pianoKey);
  };

  await client.connect(transport);
  return client;
}

/**
 * Returns a live client connected to Piano's MCP server, authenticated with
 * the given caller's own key pair. The connection is cached per key pair and
 * reused across that caller's requests; it reconnects lazily if the
 * upstream drops it.
 */
export async function getPianoClient(pianoKey: string): Promise<Client> {
  let clientPromise = clients.get(pianoKey);
  if (!clientPromise) {
    clientPromise = connect(pianoKey).catch((err) => {
      clients.delete(pianoKey);
      throw err;
    });
    clients.set(pianoKey, clientPromise);
  }
  return clientPromise;
}
