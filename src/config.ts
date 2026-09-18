import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  piano: {
    url: required("PIANO_MCP_URL"),
    transport: (process.env.PIANO_MCP_TRANSPORT ?? "streamable-http") as "streamable-http" | "sse",
  },
  wrapper: {
    port: Number(process.env.PORT ?? 3333),
  },
};
