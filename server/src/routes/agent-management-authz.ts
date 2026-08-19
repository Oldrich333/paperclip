import type { Request } from "express";
import { forbidden } from "../errors.js";
import type { accessService } from "../services/index.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

type AgentManagementAccess = Pick<ReturnType<typeof accessService>, "decide">;

export async function assertBoardCanManageAgentsForCompany(
  req: Request,
  companyId: string,
  access: AgentManagementAccess,
) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  const decision = await access.decide({
    actor: req.actor,
    action: "agents:create",
    resource: { type: "company", companyId },
  });
  if (decision.allowed) return;
  throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
}
