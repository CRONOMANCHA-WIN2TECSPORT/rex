import type { Allowlist } from "@rex/shared";

export interface AllowCheck {
  ok: boolean;
  reason?: string;
}

// Empty list = unrestricted. Any non-empty list activates that gate.
export function checkAllowlist(
  list: Allowlist,
  ctx: { owner: string; repo: string; actor: string },
): AllowCheck {
  const fullRepo = `${ctx.owner}/${ctx.repo}`;

  if (list.orgs.length > 0 && !list.orgs.includes(ctx.owner)) {
    return { ok: false, reason: `org ${ctx.owner} not in allowlist` };
  }
  if (list.repos.length > 0 && !list.repos.includes(fullRepo)) {
    return { ok: false, reason: `repo ${fullRepo} not in allowlist` };
  }
  if (list.users.length > 0 && !list.users.includes(ctx.actor)) {
    return { ok: false, reason: `user ${ctx.actor} not in allowlist` };
  }
  return { ok: true };
}
