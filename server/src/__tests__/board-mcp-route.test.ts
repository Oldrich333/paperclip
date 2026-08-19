import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { boardMcpRoutes, BOARD_MCP_TOOLS } from "../routes/board-mcp.js";

const companyId = "company-lunacare";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "board-user",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "owner" }],
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", boardMcpRoutes({} as never));
  return app;
}

describe("Board MCP route", () => {
  it("authenticates the existing Board actor and exposes the control-plane tools", async () => {
    const app = createApp(boardActor());
    const response = await request(app)
      .post("/api/board/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response.status).toBe(200);
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      BOARD_MCP_TOOLS.map((tool) => tool.name),
    );
  });

  it("requires Board authentication before MCP discovery", async () => {
    const app = createApp({ type: "none", source: "none" });
    const response = await request(app)
      .post("/api/board/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe("Board access required");
  });

  it("requires an explicit company scope for tool calls", async () => {
    const app = createApp(boardActor());
    const response = await request(app)
      .post("/api/board/mcp")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "paperclip.board.issue.list",
          arguments: {},
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.structuredContent.error).toContain("companyId is required");
  });
});
