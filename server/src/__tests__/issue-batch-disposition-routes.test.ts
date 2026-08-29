import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import {
  CROSS_ISSUE_BATCH_DISPOSITION_ACTIVITY,
} from "../services/cross-issue-influence-limit.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("bounded batch issue disposition route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-batch-disposition-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed(targetCount = 3) {
    const company = await db.insert(companies).values({
      name: "Batch Disposition Company",
      issuePrefix: `BD${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [actorAgent, targetAgent] = await db.insert(agents).values(["Actor", "Target"].map((name) => ({
      companyId: company.id,
      name,
      role: "engineer" as const,
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const responsibleUserId = `responsible-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Responsible User",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "member",
    });
    const sourceIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Sweep source issue",
      status: "todo" as const,
      priority: "medium" as const,
      assigneeAgentId: actorAgent.id,
    }).returning().then((rows) => rows[0]!);
    const targets = targetCount > 0
      ? await db.insert(issues).values(Array.from({ length: targetCount }, (_, index) => ({
        companyId: company.id,
        identifier: `${company.issuePrefix}-${index + 2}`,
        title: `Finding ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: targetAgent.id,
      }))).returning()
      : [];
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: actorAgent.id,
      status: "running",
      responsibleUserId,
      contextSnapshot: { issueId: sourceIssue.id },
    }).returning().then((rows) => rows[0]!);
    return { company, actorAgent, responsibleUserId, sourceIssue, targets, run };
  }

  function actorFor(fixture: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: fixture.actorAgent.id,
      companyId: fixture.company.id,
      runId: fixture.run.id,
      onBehalfOfUserId: fixture.responsibleUserId,
      onBehalfOfMemberships: [{
        companyId: fixture.company.id,
        membershipRole: "member",
        status: "active",
      }],
      source: "agent_jwt",
    };
  }

  async function appFor(actor: Express.Request["actor"]) {
    const { issueRoutes } = await import("../routes/issues.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("applies N items with one influence observation, comments, audit, labels, and source exemption", async () => {
    const fixture = await seed(2);
    const [addLabel, removeLabel] = await db.insert(labels).values([
      { companyId: fixture.company.id, name: "triaged", color: "#112233" },
      { companyId: fixture.company.id, name: "stale", color: "#445566" },
    ]).returning();
    await db.insert(issueLabels).values({
      companyId: fixture.company.id,
      issueId: fixture.targets[0]!.id,
      labelId: removeLabel!.id,
    });
    const app = await appFor(actorFor(fixture));
    const response = await request(app)
      .post("/api/issues/batch-dispositions")
      .send({ dispositions: [
        { issueId: fixture.sourceIssue.id, status: "done", reason: "Source finding is already handled." },
        {
          issueId: fixture.targets[0]!.id,
          status: "done",
          reason: "Confirmed duplicate of the tracked incident.",
          addLabels: [addLabel!.id],
          removeLabels: [removeLabel!.id],
        },
        { issueId: fixture.targets[1]!.id, status: "cancelled", reason: "Finding no longer reproduces." },
      ] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      itemsUsed: 3,
      itemCap: 100,
      callsUsed: 1,
      callCap: 20,
      itemsRemaining: 97,
      callsRemaining: 19,
    });
    expect(response.body.results).toEqual([
      expect.objectContaining({ issueId: fixture.sourceIssue.id, applied: true, status: "done" }),
      expect.objectContaining({ issueId: fixture.targets[0]!.id, applied: true, status: "done" }),
      expect.objectContaining({ issueId: fixture.targets[1]!.id, applied: true, status: "cancelled" }),
    ]);

    const influenceRows = await db.select().from(activityLog).where(and(
      eq(activityLog.runId, fixture.run.id),
      eq(activityLog.action, "issue.cross_issue_influence_observed"),
    ));
    expect(influenceRows).toHaveLength(1);
    expect((influenceRows[0]!.details as Record<string, unknown>).kind).toBe("batch_disposition");
    const auditRows = await db.select().from(activityLog).where(and(
      eq(activityLog.runId, fixture.run.id),
      eq(activityLog.action, CROSS_ISSUE_BATCH_DISPOSITION_ACTIVITY),
    ));
    expect(auditRows).toHaveLength(3);
    expect(auditRows.map((row) => (row.details as Record<string, unknown>).reason)).toEqual(expect.arrayContaining([
      "Source finding is already handled.",
      "Confirmed duplicate of the tracked incident.",
      "Finding no longer reproduces.",
    ]));
    expect(await db.select().from(issueComments)).toHaveLength(3);
    expect(await db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, fixture.targets[0]!.id)))
      .toEqual([{ labelId: addLabel!.id }]);
  }, 30_000);

  it("rejects blank reasons per item while applying valid siblings", async () => {
    const fixture = await seed(3);
    const app = await appFor(actorFor(fixture));
    const response = await request(app)
      .post("/api/issues/batch-dispositions")
      .send({ dispositions: [
        { issueId: fixture.targets[0]!.id, status: "done" },
        { issueId: fixture.targets[1]!.id, status: "done", reason: "   " },
        { issueId: fixture.targets[2]!.id, status: "done", reason: "Valid sweep decision." },
      ] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.itemsUsed).toBe(1);
    expect(response.body.results).toEqual([
      { issueId: fixture.targets[0]!.id, applied: false, errorCode: "reason_required" },
      { issueId: fixture.targets[1]!.id, applied: false, errorCode: "reason_required" },
      expect.objectContaining({ issueId: fixture.targets[2]!.id, applied: true }),
    ]);
  }, 30_000);

  it("rejects a foreign-company issue without an existence oracle", async () => {
    const fixture = await seed(0);
    const foreignCompany = await db.insert(companies).values({
      name: "Other Company",
      issuePrefix: `OT${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const foreignIssue = await db.insert(issues).values({
      companyId: foreignCompany.id,
      identifier: `${foreignCompany.issuePrefix}-1`,
      title: "Private finding",
      status: "todo" as const,
      priority: "medium" as const,
    }).returning().then((rows) => rows[0]!);
    const app = await appFor(actorFor(fixture));
    const response = await request(app)
      .post("/api/issues/batch-dispositions")
      .send({ dispositions: [{ issueId: foreignIssue.id, status: "done", reason: "Should not be visible." }] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.results).toEqual([{
      issueId: foreignIssue.id,
      applied: false,
      errorCode: "issue_not_found",
    }]);
    expect(response.body.callsUsed).toBe(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, foreignIssue.id)))[0]!.status).toBe("todo");
  }, 30_000);

  it("enforces the 50-item call bound and the 100-item run bound across calls", async () => {
    const fixture = await seed(4);
    const app = await appFor(actorFor(fixture));
    const tooLarge = await request(app)
      .post("/api/issues/batch-dispositions")
      .send({ dispositions: Array.from({ length: 51 }, () => ({
        issueId: fixture.targets[0]!.id,
        status: "done",
        reason: "Too many in one call.",
      })) });
    expect(tooLarge.status, JSON.stringify(tooLarge.body)).toBe(400);

    await db.insert(activityLog).values(Array.from({ length: 99 }, () => ({
      companyId: fixture.company.id,
      actorType: "agent",
      actorId: fixture.actorAgent.id,
      agentId: fixture.actorAgent.id,
      runId: fixture.run.id,
      action: CROSS_ISSUE_BATCH_DISPOSITION_ACTIVITY,
      entityType: "issue",
      entityId: fixture.targets[0]!.id,
      details: { appliedStatus: "done", reason: "Prior disposition." },
    })));
    const first = await request(app)
      .post("/api/issues/batch-dispositions")
      .send({ dispositions: fixture.targets.slice(0, 2).map((issue) => ({
        issueId: issue.id,
        status: "done",
        reason: "Prefix fits remaining budget.",
      })) });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ itemsUsed: 100, callsUsed: 1, callCap: 20 });
    expect(first.body.results).toEqual([
      expect.objectContaining({ issueId: fixture.targets[0]!.id, applied: true }),
      { issueId: fixture.targets[1]!.id, applied: false, errorCode: "item_cap_exceeded" },
    ]);
    const second = await request(app)
      .post("/api/issues/batch-dispositions")
      .send({ dispositions: [{ issueId: fixture.targets[2]!.id, status: "done", reason: "No capacity remains." }] });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ itemsUsed: 100, callsUsed: 2, callCap: 20 });
    expect(second.body.results).toEqual([{
      issueId: fixture.targets[2]!.id,
      applied: false,
      errorCode: "item_cap_exceeded",
    }]);
    expect((await db.select({ count: count() }).from(activityLog).where(eq(
      activityLog.action,
      CROSS_ISSUE_BATCH_DISPOSITION_ACTIVITY,
    )))[0]!.count).toBe(100);
  }, 30_000);

  it("serializes concurrent calls on the run row before spending the final item", async () => {
    const fixture = await seed(2);
    const app = await appFor(actorFor(fixture));
    await db.insert(activityLog).values(Array.from({ length: 99 }, () => ({
      companyId: fixture.company.id,
      actorType: "agent",
      actorId: fixture.actorAgent.id,
      agentId: fixture.actorAgent.id,
      runId: fixture.run.id,
      action: CROSS_ISSUE_BATCH_DISPOSITION_ACTIVITY,
      entityType: "issue",
      entityId: fixture.targets[0]!.id,
      details: { appliedStatus: "done", reason: "Prior disposition." },
    })));

    const [left, right] = await Promise.all([
      request(app).post("/api/issues/batch-dispositions").send({ dispositions: [
        { issueId: fixture.targets[0]!.id, status: "done", reason: "Concurrent left." },
      ] }),
      request(app).post("/api/issues/batch-dispositions").send({ dispositions: [
        { issueId: fixture.targets[1]!.id, status: "done", reason: "Concurrent right." },
      ] }),
    ]);
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    const applied = [left.body, right.body].flatMap((body) => body.results.filter((result: { applied: boolean }) => result.applied));
    expect(applied).toHaveLength(1);
    expect((await db.select({ count: count() }).from(activityLog).where(and(
      eq(activityLog.runId, fixture.run.id),
      eq(activityLog.action, CROSS_ISSUE_BATCH_DISPOSITION_ACTIVITY),
    )))[0]!.count).toBe(100);
  }, 30_000);
});
