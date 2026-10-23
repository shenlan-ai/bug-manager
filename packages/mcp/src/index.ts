import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mutationSchema, openApplication } from "@bug-manager/core";
import type { Application, Mutation } from "@bug-manager/core";

export function createMcpServer(app: Application) {
  const server = new McpServer(
    { name: "bug-manager", version: "0.1.0" },
    { maxToolInputElements: 20_000 },
  );
  for (const tool of app.tools.values()) {
    const schema = tool.write
      ? z.object({ input: tool.schema, mutation: mutationSchema })
      : z.object({ input: tool.schema });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: schema },
      async (args) => {
        const raw = args as { input: unknown; mutation?: Mutation },
          result = await app.invoke(tool.name, raw.input, raw.mutation);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: "error" in result,
        };
      },
    );
  }
  return server;
}
export async function serve(home?: string) {
  const app = await openApplication(home),
    server = createMcpServer(app);
  const close = async () => {
    await server.close();
    await app.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void app.close();
  });
  await server.connect(new StdioServerTransport());
  return server;
}
