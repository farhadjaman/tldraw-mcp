import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { broadcastOperation, eventBus, TldrawOperation } from "./eventBus.js";
import { createServer, request as httpRequest } from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as os from "os";

// Resolve log paths relative to this script (NOT the process cwd, which is "/"
// when launched by Claude Desktop and is not writable -> EACCES crash).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveLogPath(name: string): string {
  for (const dir of [__dirname, os.tmpdir()]) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, name);
    } catch {
      /* try next */
    }
  }
  return path.join(os.tmpdir(), name);
}

const mcpLogFile = fs.createWriteStream(resolveLogPath("mcp-server.log"), {
  flags: "a",
});
const httpLogFile = fs.createWriteStream(resolveLogPath("http-server.log"), {
  flags: "a",
});
// Never let a logging failure take down the MCP server.
mcpLogFile.on("error", () => {});
httpLogFile.on("error", () => {});

function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  mcpLogFile.write(`${timestamp} - ${message}\n`);
}

function logHttpToFile(message: string) {
  const timestamp = new Date().toISOString();
  httpLogFile.write(`${timestamp} - ${message}\n`);
}

// Each browser SSE (re)connection registers a tldraw-operation listener; under Next
// dev/HMR these churn fast enough to trip the default 10-listener leak warning.
eventBus.setMaxListeners(0);

// Log to file for both MCP and HTTP server
logToFile("[Combined Server] Starting MCP and HTTP server...");
logHttpToFile("[Combined Server] Starting MCP and HTTP server...");

// Build a fresh MCP server with all tools registered. In HTTP (stateless) mode we
// build one per request; in stdio mode we build a single long-lived one.
const SHAPE_COLORS = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;

function buildServer() {
  const server = new McpServer({
    name: "TldrawServer",
    version: "1.0.0",
  });

server.tool(
  "createShape",
  {
    type: z.enum(["rectangle", "ellipse", "triangle", "diamond"]),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    text: z.string().optional(),
    color: z
      .enum(SHAPE_COLORS)
      .optional()
      .describe("Stroke/label color. Defaults to black."),
    fill: z
      .enum(["none", "semi", "solid", "pattern"])
      .optional()
      .describe("Fill style for the shape. Defaults to none."),
    label: z
      .string()
      .optional()
      .describe(
        "A handle to reference this shape later in connectShapes. Defaults to `text` if omitted."
      ),
  },
  async ({ type, x, y, width, height, text, color, fill, label }) => {
    const handle = label || text;
    logToFile(
      `Creating shape: type=${type}, x=${x}, y=${y}, width=${width}, height=${height}, text=${
        text || ""
      }, color=${color || ""}, fill=${fill || ""}, label=${handle || ""}`
    );
    broadcastOperation({
      type: "createShape",
      payload: {
        shapeType: type,
        x,
        y,
        width,
        height,
        text: text || "",
        color,
        fill,
        label: handle,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: handle
            ? `Created a ${type} at (${x}, ${y}). Connect it with connectShapes using "${handle}".`
            : `Created a ${type} at (${x}, ${y})`,
        },
      ],
    };
  }
);

server.tool(
  "connectShapes",
  {
    fromId: z
      .string()
      .describe("The label/handle of the source shape (set via createShape)."),
    toId: z
      .string()
      .describe("The label/handle of the target shape (set via createShape)."),
    arrowType: z.enum(["straight", "curved", "orthogonal"]).optional(),
  },
  async ({ fromId, toId, arrowType }) => {
    broadcastOperation({
      type: "connectShapes",
      payload: {
        fromId,
        toId,
        arrowType: arrowType || "straight",
      },
    });

    return {
      content: [
        {
          type: "text",
          text: `Connected shape ${fromId} to ${toId}`,
        },
      ],
    };
  }
);

server.tool(
  "drawArrow",
  {
    x1: z.number().describe("Start point X (page coordinates)"),
    y1: z.number().describe("Start point Y"),
    x2: z.number().describe("End point X (arrowhead)"),
    y2: z.number().describe("End point Y"),
    arrowType: z.enum(["straight", "curved"]).optional(),
  },
  async ({ x1, y1, x2, y2, arrowType }) => {
    broadcastOperation({
      type: "drawArrow",
      payload: { x1, y1, x2, y2, arrowType: arrowType || "straight" },
    });

    return {
      content: [
        {
          type: "text",
          text: `Drew an arrow from (${x1}, ${y1}) to (${x2}, ${y2})`,
        },
      ],
    };
  }
);

server.tool(
  "addText",
  {
    x: z.number(),
    y: z.number(),
    text: z.string(),
    fontSize: z.number().optional(),
    label: z
      .string()
      .optional()
      .describe(
        "A handle to reference this text later in connectShapes. Defaults to `text` if omitted."
      ),
  },
  async ({ x, y, text, fontSize, label }) => {
    broadcastOperation({
      type: "addText",
      payload: {
        x,
        y,
        text,
        fontSize: fontSize || 20,
        label: label || text,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: `Added text "${text}" at position (${x}, ${y})`,
        },
      ],
    };
  }
);

server.tool(
  "deleteShape",
  {
    label: z
      .string()
      .describe(
        "The label/handle of the shape to delete (set via createShape/addText)."
      ),
  },
  async ({ label }) => {
    broadcastOperation({ type: "deleteShape", payload: { label } });
    return {
      content: [{ type: "text", text: `Deleted shape "${label}"` }],
    };
  }
);

server.tool(
  "moveShape",
  {
    label: z
      .string()
      .describe(
        "The label/handle of the shape to move (set via createShape/addText)."
      ),
    x: z.number().describe("New top-left X in page coordinates."),
    y: z.number().describe("New top-left Y in page coordinates."),
  },
  async ({ label, x, y }) => {
    broadcastOperation({ type: "moveShape", payload: { label, x, y } });
    return {
      content: [{ type: "text", text: `Moved shape "${label}" to (${x}, ${y})` }],
    };
  }
);

server.tool(
  "resizeShape",
  {
    label: z
      .string()
      .describe(
        "The label/handle of the shape to resize (set via createShape)."
      ),
    width: z.number().positive().describe("New width."),
    height: z.number().positive().describe("New height."),
  },
  async ({ label, width, height }) => {
    broadcastOperation({
      type: "resizeShape",
      payload: { label, width, height },
    });
    return {
      content: [
        {
          type: "text",
          text: `Resized shape "${label}" to ${width}×${height}`,
        },
      ],
    };
  }
);

server.tool(
  "styleShape",
  {
    label: z
      .string()
      .describe(
        "The label/handle of the shape to restyle (set via createShape/addText)."
      ),
    color: z.enum(SHAPE_COLORS).optional().describe("New stroke/label color."),
    fill: z
      .enum(["none", "semi", "solid", "pattern"])
      .optional()
      .describe("New fill style (geo shapes only)."),
  },
  async ({ label, color, fill }) => {
    if (!color && !fill) {
      return {
        content: [
          { type: "text", text: "Nothing to change: pass color and/or fill." },
        ],
        isError: true,
      };
    }
    broadcastOperation({ type: "styleShape", payload: { label, color, fill } });
    const changes = [color && `color=${color}`, fill && `fill=${fill}`]
      .filter(Boolean)
      .join(", ");
    return {
      content: [{ type: "text", text: `Restyled shape "${label}" (${changes})` }],
    };
  }
);

server.tool(
  "deleteShapesByLabels",
  {
    labels: z
      .array(z.string())
      .describe(
        "The labels/handles of the shapes to delete (set via createShape/addText)."
      ),
  },
  async ({ labels }) => {
    broadcastOperation({ type: "deleteShapesByLabels", payload: { labels } });
    return {
      content: [
        { type: "text", text: `Deleted ${labels.length} shape(s)` },
      ],
    };
  }
);

server.tool(
  "clearCanvas",
  {},
  async () => {
    broadcastOperation({ type: "clearCanvas", payload: {} });
    return {
      content: [
        { type: "text", text: "Cleared all shapes on the current page" },
      ],
    };
  }
);

server.tool(
  "deletePage",
  { name: z.string() },
  async ({ name }) => {
    broadcastOperation({ type: "deletePage", payload: { name } });
    return {
      content: [{ type: "text", text: `Deleted page "${name}"` }],
    };
  }
);

server.tool(
  "createFlowchartStep",
  {
    stepNumber: z.number(),
    title: z.string(),
    description: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    connectToPrevious: z.boolean().optional(),
  },
  async ({ stepNumber, title, description, x, y, connectToPrevious }) => {
    const posX = x || stepNumber * 200;
    const posY = y || 200;

    broadcastOperation({
      type: "createFlowchartStep",
      payload: {
        stepNumber,
        title,
        description: description || "",
        x: posX,
        y: posY,
        connectToPrevious: connectToPrevious !== false,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: `Created flowchart step ${stepNumber}: ${title}`,
        },
      ],
    };
  }
);

server.tool("getSnapshot", {}, async () => {
  return new Promise((resolve) => {
    const requestId = `snapshot-${Date.now()}`;
    broadcastOperation({
      type: "requestSnapshot",
      payload: { requestId },
    });
    const snapshotListener = (data: {
      type: string;
      payload: Record<string, unknown>;
    }) => {
      if (
        data.type === "snapshotResponse" &&
        "requestId" in data.payload &&
        data.payload.requestId === requestId
      ) {
        eventBus.off("snapshot-response", snapshotListener);

        resolve({
          content: [
            {
              type: "text",
              text: `Diagram snapshot captured`,
            },
          ],
          snapshot:
            "snapshot" in data.payload
              ? (data.payload.snapshot as Record<string, unknown>)
              : {},
        });
      }
    };

    eventBus.on("snapshot-response", snapshotListener);

    setTimeout(() => {
      eventBus.off("snapshot-response", snapshotListener);
      resolve({
        content: [
          {
            type: "text",
            text: `Failed to capture diagram snapshot (timeout)`,
          },
        ],
      });
    }, 5000);
  });
});

server.tool(
  "createPage",
  { name: z.string() },
  async ({ name }) => {
    broadcastOperation({ type: "createPage", payload: { name } });
    return {
      content: [
        {
          type: "text",
          text: `Created page "${name}" and switched to it`,
        },
      ],
    };
  }
);

server.tool(
  "switchPage",
  { name: z.string() },
  async ({ name }) => {
    broadcastOperation({ type: "switchPage", payload: { name } });
    return {
      content: [
        {
          type: "text",
          text: `Switched to page "${name}"`,
        },
      ],
    };
  }
);

server.tool("listPages", {}, async () => {
  return new Promise((resolve) => {
    const requestId = `pages-${Date.now()}`;
    broadcastOperation({ type: "requestPageList", payload: { requestId } });

    const listener = (data: {
      type: string;
      payload: Record<string, unknown>;
    }) => {
      if (
        data.type === "pageListResponse" &&
        data.payload.requestId === requestId
      ) {
        eventBus.off("page-list-response", listener);
        const pages =
          (data.payload.pages as { name: string; current: boolean }[]) || [];
        const text = pages.length
          ? pages.map((p) => `${p.current ? "* " : "  "}${p.name}`).join("\n")
          : "No pages";
        resolve({ content: [{ type: "text", text }] });
      }
    };

    eventBus.on("page-list-response", listener);

    setTimeout(() => {
      eventBus.off("page-list-response", listener);
      resolve({
        content: [{ type: "text", text: "Failed to list pages (timeout)" }],
      });
    }, 5000);
  });
});

  return server;
}

// stdio (local Claude Desktop) by default; "http" exposes a remote /mcp endpoint.
const MCP_TRANSPORT = process.env.MCP_TRANSPORT ?? "stdio";
if (MCP_TRANSPORT === "stdio") {
  const stdioServer = buildServer();
  await stdioServer.connect(new StdioServerTransport());
  logToFile("[MCP] Connected over stdio");
} else {
  logToFile("[MCP] HTTP transport enabled at /mcp");
}

// Create and start the HTTP server (after MCP server is initialized)
const httpServer = createServer((req, res) => {
  logHttpToFile(`[HTTP Server] Received ${req.method} request to ${req.url}`);
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url === "/mcp" && req.method === "POST") {
    // Remote MCP over Streamable HTTP, stateless: a fresh server+transport per
    // request. Tool calls still broadcast onto the shared in-process eventBus.
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const parsed = body ? JSON.parse(body) : undefined;
        const mcp = buildServer();
        const mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          mcpTransport.close();
          mcp.close();
        });
        await mcp.connect(mcpTransport);
        await mcpTransport.handleRequest(req, res, parsed);
      } catch (error) {
        logHttpToFile(`[MCP] Error handling /mcp request: ${error}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    });
  } else if (req.url === "/mcp") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
  } else if (req.url === "/api/tldraw-events" && req.method === "GET") {
    logHttpToFile("[HTTP Server] SSE connection established");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type",
    });

    // Send a heartbeat every 30 seconds to keep the connection alive
    const heartbeatInterval = setInterval(() => {
      res.write("event: heartbeat\ndata: ping\n\n");
    }, 30000); // Function to send SSE events
    const sendEvent = (event: string, data: Record<string, unknown>) => {
      logHttpToFile(
        `[HTTP Server] Sending ${event} event: ${JSON.stringify(data)}`
      );
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial connection confirmation
    sendEvent("connected", { message: "Connected to TldrawServer" }); // Listen for tldraw operations and forward them to the client
    const operationListener = (operation: TldrawOperation) => {
      logHttpToFile(
        `[HTTP Server] Received operation from EventBus: ${JSON.stringify(
          operation
        )}`
      );
      sendEvent("tldraw-operation", operation);
    };

    // Register event listener
    eventBus.on("tldraw-operation", operationListener); // Handle client disconnect
    req.on("close", () => {
      clearInterval(heartbeatInterval);
      eventBus.off("tldraw-operation", operationListener);
      logHttpToFile("[HTTP Server] Client disconnected from SSE");
    });
  } // for snapshot endpoint
  else if (req.url === "/api/snapshot" && req.method === "POST") {
    logHttpToFile("[HTTP Server] Received snapshot POST request");
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const { requestId, snapshot } = data;
        logHttpToFile(
          `[HTTP Server] Processing snapshot with requestId: ${requestId}`
        );
        logHttpToFile(
          `[HTTP Server] Snapshot size: ${
            JSON.stringify(snapshot).length
          } bytes`
        );

        eventBus.emit("snapshot-response", {
          type: "snapshotResponse",
          payload: { requestId, snapshot },
        });

        logHttpToFile(`[HTTP Server] Emitted snapshot-response event`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        logHttpToFile(`[HTTP Server] Error processing snapshot: ${error}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error: "Failed to process snapshot",
          })
        );
      }
    });
  } else if (req.url === "/api/page-list" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const { requestId, pages } = JSON.parse(body);
        eventBus.emit("page-list-response", {
          type: "pageListResponse",
          payload: { requestId, pages },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        logHttpToFile(`[HTTP Server] Error processing page list: ${error}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false }));
      }
    });
  } else if (req.url === "/api/shutdown" && req.method === "POST") {
    // A newer instance is taking over port 3002. Step down so it can bind.
    logHttpToFile("[HTTP Server] Received shutdown request; exiting to free port 3002");
    res.writeHead(200);
    res.end("ok");
    httpServer.close();
    setTimeout(() => process.exit(0), 100);
  } else {
    logHttpToFile(`[HTTP Server] Unknown endpoint: ${req.url}`);
    res.writeHead(404);
    res.end("Not found");
  }
});

// The browser's SSE stream and the MCP tool handlers must share THIS process's
// in-memory eventBus. If a stale instance (e.g. a previous Claude Desktop launch
// that never exited) still owns port 3002, the browser stays attached to the dead
// instance and never sees our operations. So when we hit EADDRINUSE we ask the
// stale instance to step down, then take over the port ourselves.
const PORT = Number(process.env.PORT ?? 3002);
let portTakeoverAttempted = false;
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && !portTakeoverAttempted) {
    portTakeoverAttempted = true;
    logHttpToFile(`[HTTP Server] Port ${PORT} in use; asking the stale instance to step down`);
    const shutdownReq = httpRequest({
      hostname: "localhost",
      port: PORT,
      path: "/api/shutdown",
      method: "POST",
    });
    shutdownReq.on("error", () => {});
    shutdownReq.end();
    setTimeout(() => httpServer.listen(PORT), 600);
    return;
  }
  logHttpToFile(`[HTTP Server] listen error: ${err.code || err.message}`);
});

httpServer.listen(PORT, () => {
  logHttpToFile(`[HTTP Server] HTTP Server running on port ${PORT}`);
  logHttpToFile(
    `[HTTP Server] EventBus listeners: ${eventBus.listenerCount(
      "tldraw-operation"
    )}`
  );

  // Add listener to log operations (useful for debugging)
  eventBus.on("tldraw-operation", (operation) => {
    logHttpToFile(
      `[HTTP Server] EventBus operation: ${JSON.stringify(operation)}`
    );
    logHttpToFile(
      `[HTTP Server] Current listeners: ${eventBus.listenerCount(
        "tldraw-operation"
      )}`
    );
  });
});
