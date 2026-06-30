import { NextRequest, NextResponse } from "next/server";
import http from "http";

export async function POST(req: NextRequest) {
  try {
    const { requestId, pages } = await req.json();

    const bridge = new URL(process.env.BRIDGE_URL ?? "http://localhost:3002");
    const mcpRequest = http.request({
      hostname: bridge.hostname,
      port: bridge.port || 3002,
      path: "/api/page-list",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    mcpRequest.on("error", () => {});
    mcpRequest.write(JSON.stringify({ requestId, pages }));
    mcpRequest.end();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error handling page list:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process page list" },
      { status: 500 }
    );
  }
}
