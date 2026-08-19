import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueGetById: vi.fn(),
  getRun: vi.fn(),
  wakeup: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({
    getRun: mocks.getRun,
    wakeup: mocks.wakeup,
  }),
  ISSUE_LIST_MAX_LIMIT: 200,
  issueService: () => ({ getById: mocks.issueGetById }),
  logActivity: mocks.logActivity,
}));

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

function issue() {
  return {
    id: "issue-1",
    companyId,
    identifier: "LUN-625",
    title: "Exchange follow-up",
    status: "in_progress",
    assigneeAgentId: "agent-1",
  };
}

function createApp(actor: Record<string, unknown>, lifecycleEvents: string[] = []) {
  const app = express();
  const api = express.Router();
  const issueRouter = express.Router();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  issueRouter.get("/companies/:companyId/issues", (_req, res) => {
    lifecycleEvents.push("list");
    res.json([issue()]);
  });
  issueRouter.get("/issues/:issueId", (_req, res) => {
    lifecycleEvents.push("get");
    res.json(issue());
  });
  issueRouter.post("/companies/:companyId/issues", (req, res) => {
    lifecycleEvents.push("create.assignment");
    lifecycleEvents.push("create.reference_sync");
    if (req.body.idempotencyKey === "duplicate") {
      res.json({ ...issue(), deduplicated: true, deduplicationReason: "idempotency_key" });
      return;
    }
    res.status(201).json({ ...issue(), ...req.body });
  });
  issueRouter.patch("/issues/:issueId", (req, res) => {
    lifecycleEvents.push("update.status");
    lifecycleEvents.push("update.dependency_wakeup");
    lifecycleEvents.push("update.reference_sync");
    if (req.body.status === "cancelled") lifecycleEvents.push("update.run_cancelled");
    res.json({ ...issue(), ...req.body });
  });
  issueRouter.post("/issues/:issueId/comments", (req, res) => {
    lifecycleEvents.push("comment.mention_wakeup");
    lifecycleEvents.push("comment.reference_sync");
    res.status(201).json({ id: "comment-1", issueId: req.params.issueId, body: req.body.body });
  });
  api.use(boardMcpRoutes({} as never, { issueRouter }));
  api.use(issueRouter);
  app.use("/api", api);
  return app;
}

async function callTool(app: express.Express, name: string, args: Record<string, unknown>) {
  return request(app)
    .post("/api/board/mcp")
    .send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
}

describe("Board MCP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueGetById.mockResolvedValue(issue());
    mocks.getRun.mockResolvedValue(null);
    mocks.wakeup.mockResolvedValue({ id: "run-1" });
    mocks.logActivity.mockResolvedValue(undefined);
  });

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

  it("runs create, update, cancellation, and comment through the normal issue lifecycle routes", async () => {
    const lifecycleEvents: string[] = [];
    const app = createApp(boardActor(), lifecycleEvents);

    const created = await callTool(app, "paperclip.board.issue.create", {
      companyId,
      title: "Exchange follow-up",
    });
    const updated = await callTool(app, "paperclip.board.issue.update", {
      companyId,
      issueId: "issue-1",
      patch: { status: "cancelled" },
    });
    const commented = await callTool(app, "paperclip.board.issue.comment", {
      companyId,
      issueId: "issue-1",
      body: "Continue with the replacement",
    });

    expect(created.status).toBe(200);
    expect(updated.status).toBe(200);
    expect(commented.status).toBe(200);
    expect(lifecycleEvents).toEqual([
      "create.assignment",
      "create.reference_sync",
      "update.status",
      "update.dependency_wakeup",
      "update.reference_sync",
      "update.run_cancelled",
      "comment.mention_wakeup",
      "comment.reference_sync",
    ]);
    expect(updated.body.result.structuredContent.status).toBe("cancelled");
    expect(commented.body.result.structuredContent.body).toBe("Continue with the replacement");
  });

  it("dispatches get and list through the shared issue router in the production nested mount", async () => {
    const lifecycleEvents: string[] = [];
    const app = createApp(boardActor(), lifecycleEvents);

    const fetched = await callTool(app, "paperclip.board.issue.get", {
      companyId,
      issueId: "issue-1",
    });
    const listed = await callTool(app, "paperclip.board.issue.list", {
      companyId,
      status: ["todo", "in_progress"],
      assigneeAgentId: null,
    });

    expect(fetched.status).toBe(200);
    expect(fetched.body.result.structuredContent.id).toBe("issue-1");
    expect(listed.status).toBe(200);
    expect(listed.body.result.structuredContent).toEqual([expect.objectContaining({ id: "issue-1" })]);
    expect(lifecycleEvents).toEqual(["get", "list"]);
  });

  it("preserves the normal create deduplication response without emitting a created audit", async () => {
    const response = await callTool(createApp(boardActor()), "paperclip.board.issue.create", {
      companyId,
      title: "Exchange follow-up",
      idempotencyKey: "duplicate",
    });

    expect(response.status).toBe(200);
    expect(response.body.result.structuredContent).toMatchObject({
      id: "issue-1",
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it.each([
    ["paperclip.board.run.start", {}],
    ["paperclip.board.run.resume", { runId: "prior-run" }],
  ])("does not audit %s when the normal wakeup lifecycle skips it", async (toolName, extraArgs) => {
    mocks.getRun.mockResolvedValue({
      id: "prior-run",
      companyId,
      agentId: "agent-1",
      contextSnapshot: { issueId: "issue-1" },
    });
    mocks.wakeup.mockResolvedValue(null);

    const response = await callTool(createApp(boardActor()), toolName, {
      companyId,
      issueId: "issue-1",
      ...extraArgs,
    });

    expect(response.status).toBe(200);
    expect(response.body.result.structuredContent).toMatchObject({
      issueId: "issue-1",
      agentId: "agent-1",
      run: null,
      status: "skipped",
    });
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("audits a started run only when wakeup returns a durable run", async () => {
    const response = await callTool(createApp(boardActor()), "paperclip.board.run.start", {
      companyId,
      issueId: "issue-1",
    });

    expect(response.status).toBe(200);
    expect(response.body.result.structuredContent.status).toBe("queued");
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "board_mcp.run_started",
        runId: "run-1",
        entityId: "issue-1",
      }),
    );
  });
});
