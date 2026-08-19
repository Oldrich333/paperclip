import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolAccessAuditEvents, toolCallEvents, toolConnections } from "@paperclipai/db";

export const REMOTE_FAILURE_DEMOTION_THRESHOLD = 3;

type RemoteConnectionHealthStatus = "ok" | "error" | "missing_secret";

export async function updateRemoteConnectionHealth(
  db: Db,
  connection: typeof toolConnections.$inferSelect,
  status: RemoteConnectionHealthStatus,
  message: string | null,
  options: { countFailure?: boolean } = {},
) {
  const now = new Date();
  let nextStatus: RemoteConnectionHealthStatus | "degraded" = status;
  let nextMessage = message;
  if (status === "error" && options.countFailure !== false) {
    const [recentCallEvents, recentHealthEvents] = await Promise.all([
      db
        .select({ eventType: toolCallEvents.eventType, outcome: toolCallEvents.outcome, createdAt: toolCallEvents.createdAt })
        .from(toolCallEvents)
        .where(and(
          eq(toolCallEvents.companyId, connection.companyId),
          eq(toolCallEvents.connectionId, connection.id),
          inArray(toolCallEvents.eventType, ["call_completed", "call_failed"]),
        ))
        .orderBy(desc(toolCallEvents.createdAt))
        .limit(REMOTE_FAILURE_DEMOTION_THRESHOLD),
      db
        .select({ outcome: toolAccessAuditEvents.outcome, details: toolAccessAuditEvents.details, createdAt: toolAccessAuditEvents.createdAt })
        .from(toolAccessAuditEvents)
        .where(and(
          eq(toolAccessAuditEvents.companyId, connection.companyId),
          eq(toolAccessAuditEvents.connectionId, connection.id),
          inArray(toolAccessAuditEvents.action, ["tool_connection.health_check", "tool_connection.catalog_refresh"]),
        ))
        .orderBy(desc(toolAccessAuditEvents.createdAt))
        .limit(REMOTE_FAILURE_DEMOTION_THRESHOLD),
    ]);
    const recentEvents = [
      ...recentCallEvents.map((event) => ({
        createdAt: event.createdAt,
        outcome: event.eventType === "call_completed" && event.outcome === "success"
          ? "success"
          : event.eventType === "call_failed" && ["failure", "timeout"].includes(event.outcome)
            ? "failure"
            : "break",
      })),
      ...recentHealthEvents
        .filter((event) => event.outcome === "success" || (event.outcome === "failure" && event.details?.status === "error"))
        .map((event) => ({
          createdAt: event.createdAt,
          outcome: event.outcome === "success" ? "success" : "failure",
        })),
    ]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, REMOTE_FAILURE_DEMOTION_THRESHOLD);
    let consecutiveFailures = 1;
    for (const event of recentEvents) {
      if (event.outcome === "success" || event.outcome === "break") break;
      consecutiveFailures += 1;
    }
    nextStatus = consecutiveFailures >= REMOTE_FAILURE_DEMOTION_THRESHOLD ? "error" : "degraded";
    if (nextStatus === "degraded") {
      nextMessage = `${message ?? "Remote MCP tool call failed."} (${consecutiveFailures}/${REMOTE_FAILURE_DEMOTION_THRESHOLD} consecutive failures; tools remain available.)`;
    }
  }
  const [updated] = await db
    .update(toolConnections)
    .set({
      healthStatus: nextStatus,
      healthMessage: nextMessage,
      healthCheckedAt: now,
      lastHealthAt: now,
      lastError: nextStatus === "ok" ? null : message,
      updatedAt: now,
    })
    .where(eq(toolConnections.id, connection.id))
    .returning();
  return updated;
}
