import { Router, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import {
  heartbeatService,
  ISSUE_LIST_MAX_LIMIT,
  issueService,
  logActivity,
} from "../services/index.js";
import { HttpError, notFound, unprocessable } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Board-scoped Paperclip control-plane tools.
 *
 * This is intentionally a first-party MCP surface, not a catalog/provider
 * tool.  It uses the normal request actor middleware (BetterAuth session or
 * Board API key) and the same issue/heartbeat services as the Board routes.
 * Every tool call carries an explicit companyId because the interactive T3
 * surface can be multiplexed across companies.
 */

const companyIdSchema = z.string().trim().min(1);
const issueReferenceSchema = z.string().trim().min(1);

const issueGetArgsSchema = z.object({
  companyId: companyIdSchema,
  issueId: issueReferenceSchema,
}).strict();

const issueListArgsSchema = z.object({
  companyId: companyIdSchema,
  status: z.union([z.string(), z.array(z.string())]).optional(),
  q: z.string().optional(),
  assigneeAgentId: z.string().optional().nullable(),
  assigneeUserId: z.string().optional(),
  limit: z.number().int().positive().max(ISSUE_LIST_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();

const issueUpdateArgsSchema = z.object({
  companyId: companyIdSchema,
  issueId: issueReferenceSchema,
  patch: z.record(z.string(), z.unknown()),
}).strict();

const issueCommentArgsSchema = z.object({
  companyId: companyIdSchema,
  issueId: issueReferenceSchema,
  body: z.string().min(1),
}).strict();

const runArgsSchema = z.object({
  companyId: companyIdSchema,
  issueId: issueReferenceSchema,
  runId: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
}).strict();

const BOARD_MCP_PROTOCOL_VERSION = "2025-03-26";

export const BOARD_MCP_TOOLS = [
  {
    name: "paperclip.board.issue.get",
    title: "Get a Paperclip issue",
    description: "Read one LunaCare/Paperclip issue by UUID or identifier within an explicit company scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["companyId", "issueId"],
      properties: {
        companyId: { type: "string", description: "Paperclip company UUID or company slug-resolved ID." },
        issueId: { type: "string", description: "Issue UUID or identifier such as LUN-625." },
      },
    },
  },
  {
    name: "paperclip.board.issue.list",
    title: "List Paperclip issues",
    description: "List visible Paperclip issues within one explicit company scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["companyId"],
      properties: {
        companyId: { type: "string" },
        status: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        q: { type: "string" },
        assigneeAgentId: { type: ["string", "null"] },
        assigneeUserId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: ISSUE_LIST_MAX_LIMIT },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "paperclip.board.issue.create",
    title: "Create a Paperclip issue",
    description: "Create a normal Paperclip issue in the explicitly selected company.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["companyId", "title"],
      properties: {
        companyId: { type: "string" },
        title: { type: "string", minLength: 1 },
        description: { type: ["string", "null"] },
        status: { type: "string" },
        priority: { type: "string" },
        assigneeAgentId: { type: ["string", "null"] },
        assigneeUserId: { type: ["string", "null"] },
        projectId: { type: ["string", "null"] },
        parentId: { type: ["string", "null"] },
        idempotencyKey: { type: ["string", "null"] },
      },
    },
  },
  {
    name: "paperclip.board.issue.update",
    title: "Update a Paperclip issue",
    description: "Update a Paperclip issue using the normal issue fields within one explicit company scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["companyId", "issueId", "patch"],
      properties: {
        companyId: { type: "string" },
        issueId: { type: "string" },
        patch: { type: "object", additionalProperties: true },
      },
    },
  },
  {
    name: "paperclip.board.issue.comment",
    title: "Comment on a Paperclip issue",
    description: "Add a Board-authored comment to a Paperclip issue within one explicit company scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["companyId", "issueId", "body"],
      properties: {
        companyId: { type: "string" },
        issueId: { type: "string" },
        body: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "paperclip.board.run.start",
    title: "Start a Paperclip issue run",
    description: "Start or wake the assigned agent for a Paperclip issue.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["companyId", "issueId"],
      properties: {
        companyId: { type: "string" },
        issueId: { type: "string" },
        idempotencyKey: { type: "string" },
      },
    },
  },
  {
    name: "paperclip.board.run.resume",
    title: "Resume a Paperclip issue run",
    description: "Resume the assigned agent's prior session for a Paperclip issue, optionally from a specific run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["companyId", "issueId"],
      properties: {
        companyId: { type: "string" },
        issueId: { type: "string" },
        runId: { type: "string", description: "Prior run UUID; when omitted Paperclip selects the latest terminal run for this issue." },
        idempotencyKey: { type: "string" },
      },
    },
  },
] as const;

type BoardMcpToolName = (typeof BOARD_MCP_TOOLS)[number]["name"];
const BOARD_MCP_READ_TOOLS = new Set<BoardMcpToolName>([
  "paperclip.board.issue.get",
  "paperclip.board.issue.list",
]);
const BOARD_MCP_ISSUE_TOOLS = new Set<BoardMcpToolName>([
  "paperclip.board.issue.get",
  "paperclip.board.issue.list",
  "paperclip.board.issue.create",
  "paperclip.board.issue.update",
  "paperclip.board.issue.comment",
]);

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function parseIssueReference(issueId: string) {
  return issueId.trim();
}

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

function zodFailure(error: z.ZodError) {
  return new HttpError(422, "Invalid Paperclip Board tool arguments", {
    issues: error.issues,
  });
}

type ForwardedIssueRequest = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  body: Record<string, unknown>;
};

function queryString(entries: Array<[string, string | number | null | undefined]>) {
  const query = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function parseForwardedIssueRequest(name: BoardMcpToolName, rawArgs: unknown): ForwardedIssueRequest {
  switch (name) {
    case "paperclip.board.issue.get": {
      const parsed = issueGetArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw zodFailure(parsed.error);
      return {
        method: "GET",
        url: `/issues/${encodeURIComponent(parsed.data.issueId)}`,
        body: {},
      };
    }
    case "paperclip.board.issue.list": {
      const parsed = issueListArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw zodFailure(parsed.error);
      const status = Array.isArray(parsed.data.status)
        ? parsed.data.status.join(",")
        : parsed.data.status;
      return {
        method: "GET",
        url: `/companies/${encodeURIComponent(parsed.data.companyId)}/issues${queryString([
          ["status", status],
          ["q", parsed.data.q],
          ["assigneeAgentId", parsed.data.assigneeAgentId === null ? "null" : parsed.data.assigneeAgentId],
          ["assigneeUserId", parsed.data.assigneeUserId],
          ["limit", parsed.data.limit],
          ["offset", parsed.data.offset],
        ])}`,
        body: {},
      };
    }
    case "paperclip.board.issue.create": {
      if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
        throw new HttpError(422, "Tool arguments must be an object");
      }
      const { companyId: _companyId, ...body } = rawArgs as Record<string, unknown>;
      return {
        method: "POST",
        url: `/companies/${encodeURIComponent(String(_companyId).trim())}/issues`,
        body,
      };
    }
    case "paperclip.board.issue.update": {
      const parsed = issueUpdateArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw zodFailure(parsed.error);
      return {
        method: "PATCH",
        url: `/issues/${encodeURIComponent(parsed.data.issueId)}`,
        body: parsed.data.patch,
      };
    }
    case "paperclip.board.issue.comment": {
      const parsed = issueCommentArgsSchema.safeParse(rawArgs);
      if (!parsed.success) throw zodFailure(parsed.error);
      return {
        method: "POST",
        url: `/issues/${encodeURIComponent(parsed.data.issueId)}/comments`,
        body: { body: parsed.data.body },
      };
    }
    default:
      throw new HttpError(404, `Unknown Board issue tool: ${name}`);
  }
}

function forwardIssueTool(
  req: Request,
  res: Response,
  next: NextFunction,
  id: unknown,
  target: ForwardedIssueRequest,
) {
  const originalJson = res.json.bind(res);
  res.json = ((data: unknown) => {
    const status = res.statusCode;
    if (status === 401 || status === 403) {
      return originalJson(jsonRpcError(
        id,
        status === 401 ? -32001 : -32003,
        data && typeof data === "object" && "error" in data
          ? String((data as { error?: unknown }).error ?? "Request denied")
          : "Request denied",
        data,
      ));
    }
    res.status(200);
    return originalJson({
      jsonrpc: "2.0",
      id: id ?? null,
      result: toolResult(data, status < 200 || status >= 300),
    });
  }) as Response["json"];
  req.method = target.method;
  req.url = target.url;
  req.body = target.body;
  next("router");
}

async function requireIssue(
  req: Request,
  svc: ReturnType<typeof issueService>,
  companyId: string,
  issueId: string,
) {
  const issue = await svc.getById(parseIssueReference(issueId));
  if (!issue || issue.companyId !== companyId || !hasCompanyAccess(req, issue.companyId)) {
    throw notFound("Issue not found");
  }
  return issue;
}

async function latestTerminalRunForIssue(db: Db, companyId: string, agentId: string, issueId: string) {
  return db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      sql`${heartbeatRuns.status} not in ('queued', 'running', 'scheduled_retry')`,
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

function boardActorId(req: Request) {
  const actor = getActorInfo(req);
  if (actor.actorType !== "user") throw new HttpError(403, "Board authentication required");
  return actor;
}

export function boardMcpRoutes(db: Db, options: { pluginWorkerManager?: PluginWorkerManager } = {}) {
  const router = Router();
  const svc = issueService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  async function authorizeToolCall(req: Request, name: BoardMcpToolName, rawArgs: unknown) {
    assertBoard(req);
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      throw new HttpError(422, "Tool arguments must be an object");
    }
    const companyId = typeof (rawArgs as Record<string, unknown>).companyId === "string"
      ? String((rawArgs as Record<string, unknown>).companyId).trim()
      : "";
    if (!companyId) throw new HttpError(422, "companyId is required for every Board tool call");
    if (BOARD_MCP_READ_TOOLS.has(name)) {
      if (!hasCompanyAccess(req, companyId)) throw new HttpError(403, "User does not have access to this company");
    } else {
      assertCompanyAccess(req, companyId);
    }
    const actor = boardActorId(req);
    if (
      name === "paperclip.board.issue.get" ||
      name === "paperclip.board.issue.update" ||
      name === "paperclip.board.issue.comment"
    ) {
      const issueId = (rawArgs as Record<string, unknown>).issueId;
      if (typeof issueId === "string" && issueId.trim()) {
        await requireIssue(req, svc, companyId, issueId);
      }
    }
    return { actor, companyId };
  }

  async function executeRunTool(req: Request, name: BoardMcpToolName, rawArgs: unknown) {
    const { actor, companyId } = await authorizeToolCall(req, name, rawArgs);

    switch (name) {
      case "paperclip.board.run.start":
      case "paperclip.board.run.resume": {
        const parsed = runArgsSchema.safeParse(rawArgs);
        if (!parsed.success) throw zodFailure(parsed.error);
        const issue = await requireIssue(req, svc, parsed.data.companyId, parsed.data.issueId);
        if (!issue.assigneeAgentId) {
          throw unprocessable("Issue has no assigned agent to start or resume");
        }

        let resumeFromRunId: string | null = null;
        if (name.endsWith("resume")) {
          resumeFromRunId = parsed.data.runId ?? await latestTerminalRunForIssue(db, companyId, issue.assigneeAgentId, issue.id);
          if (resumeFromRunId) {
            const prior = await heartbeat.getRun(resumeFromRunId);
            const priorContext = prior?.contextSnapshot && typeof prior.contextSnapshot === "object"
              ? prior.contextSnapshot as Record<string, unknown>
              : null;
            if (
              !prior ||
              prior.companyId !== companyId ||
              prior.agentId !== issue.assigneeAgentId ||
              priorContext?.issueId !== issue.id
            ) {
              throw new HttpError(422, "runId is not a run for this issue's assigned agent and company");
            }
          }
        }

        const isResume = name.endsWith("resume");
        const run = await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: isResume ? "board_issue_resume" : "board_issue_start",
          payload: {
            issueId: issue.id,
            mutation: isResume ? "board_mcp.run.resume" : "board_mcp.run.start",
            ...(resumeFromRunId ? { resumeFromRunId } : {}),
          },
          idempotencyKey: parsed.data.idempotencyKey,
          requestedByActorType: "user",
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            source: isResume ? "board.mcp.run.resume" : "board.mcp.run.start",
            ...(isResume ? { resumeIntent: true, followUpRequested: true } : {}),
          },
        });
        if (run) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: actor.actorId,
            agentId: issue.assigneeAgentId,
            runId: run.id,
            action: isResume ? "board_mcp.run_resumed" : "board_mcp.run_started",
            entityType: "issue",
            entityId: issue.id,
            details: { identifier: issue.identifier, runId: run.id, resumeFromRunId, source: "board_mcp" },
          });
        }
        return { issueId: issue.id, agentId: issue.assigneeAgentId, run, resumeFromRunId, status: run ? "queued" : "skipped" };
      }
      default:
        throw new HttpError(404, `Unknown Board tool: ${name}`);
    }
  }

  async function handleMcp(req: Request, res: Response, next: NextFunction) {
    const body = (req.body ?? {}) as JsonRpcRequest;
    const id = body.id ?? null;
    try {
      assertBoard(req);
      if (body.method === "initialize") {
        res.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: BOARD_MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "Paperclip Board MCP", version: "1.0.0" },
          },
        });
        return;
      }
      if (body.method === "notifications/initialized") {
        res.status(202).end();
        return;
      }
      if (body.method === "tools/list") {
        res.json({ jsonrpc: "2.0", id, result: { tools: BOARD_MCP_TOOLS } });
        return;
      }
      if (body.method !== "tools/call") {
        res.status(404).json(jsonRpcError(id, -32601, "Method not found"));
        return;
      }
      const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? body.params as Record<string, unknown>
        : {};
      const name = typeof params.name === "string" ? params.name as BoardMcpToolName : "";
      if (!name || !BOARD_MCP_TOOLS.some((tool) => tool.name === name)) {
        res.status(400).json(jsonRpcError(id, -32602, "params.name must name a Board MCP tool"));
        return;
      }
      const args = params.arguments ?? {};
      if (BOARD_MCP_ISSUE_TOOLS.has(name)) {
        await authorizeToolCall(req, name, args);
        const target = parseForwardedIssueRequest(name, args);
        forwardIssueTool(req, res, next, id, target);
        return;
      }
      const data = await executeRunTool(req, name, args);
      res.json({ jsonrpc: "2.0", id, result: toolResult(data) });
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError) {
        if (error.status === 401 || error.status === 403) {
          res.status(error.status).json(jsonRpcError(id, error.status === 401 ? -32001 : -32003, error.message, error.details));
          return;
        }
        res.json({ jsonrpc: "2.0", id, result: toolResult({ error: error.message, details: error.details }, true) });
        return;
      }
      throw error;
    }
  }

  router.get("/board/mcp", (_req, res) => {
    res.json({ transport: "streamable_http", endpoint: "/api/board/mcp", authentication: "board_session_or_key" });
  });
  router.post("/board/mcp", handleMcp);
  return router;
}
