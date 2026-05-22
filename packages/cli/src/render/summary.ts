import type { Finding, ReviewSubmission, Severity } from "@rex/shared";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "nit"];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🛑 Critical",
  high: "⚠️ High",
  medium: "🟡 Medium",
  low: "🔵 Low",
  nit: "💭 Nit",
};

export function renderReviewBody(submission: ReviewSubmission): string {
  const counts = countBySeverity(submission.findings);
  const header = renderHeader(counts);
  const breakdown = renderBreakdown(submission.findings);

  return [
    "## 🦖 rex review",
    "",
    header,
    "",
    submission.summary.trim(),
    breakdown ? "\n" + breakdown : "",
  ].join("\n");
}

export function renderInlineComment(finding: Finding): string {
  const lines = [`**${SEVERITY_LABEL[finding.severity]}** · _${finding.category}_`, "", finding.message.trim()];
  if (finding.suggestion && finding.suggestion.trim()) {
    lines.push("", "```suggestion", finding.suggestion.replace(/\n+$/, ""), "```");
  }
  return lines.join("\n");
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    nit: 0,
  };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function renderHeader(counts: Record<Severity, number>): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return "_No issues found._";
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
    (s) => `${SEVERITY_LABEL[s]} ${counts[s]}`,
  );
  return parts.join(" · ");
}

function renderBreakdown(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const grouped: Record<Severity, Finding[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
    nit: [],
  };
  for (const f of findings) grouped[f.severity].push(f);

  const sections: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const list = grouped[sev];
    if (list.length === 0) continue;
    const items = list.map(
      (f) => `- \`${f.path}:${f.line}\` — ${firstLine(f.message)}`,
    );
    sections.push(`<details><summary>${SEVERITY_LABEL[sev]} (${list.length})</summary>\n\n${items.join("\n")}\n\n</details>`);
  }
  return sections.join("\n");
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim();
}
