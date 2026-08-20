// Permission grants for the tools delivered by Paperclip's runtime MCP gateways.
//
// Paperclip already decides the *availability* of these tools: tool-access
// profiles pick the Connections, and the runtime mints short-lived tokens and
// writes the resulting servers into the client's MCP configuration. That
// decision has to be carried into *permission* as well. Without it the two
// layers never meet — the gateway is attached and its tools are advertised, but
// the client refuses every `mcp__*` call inside its own tool loop before any
// Paperclip check runs, so the agent has no usable gateway tools at all.
//
// Granting these adds no authority. Gateway attachment is itself the governed
// decision: profiles, credentials, approvals and company boundaries are
// unchanged and still enforced server-side on every call. This only makes
// permission agree with availability, instead of advertising tools that cannot
// be called.
//
// Two spellings are emitted per server. They denote the identical grant —
// "every tool from this server" — but are recognised by different matcher paths
// across Claude Code releases, and an adapter cannot pin the CLI version
// installed on a remote target:
//
//   mcp__<server>      canonical whole-server form
//   mcp__<server>__*   wildcard form
//
// Server names are gateway slugs: executable identifiers rather than display
// labels. A name containing whitespace is dropped rather than emitted, because
// `--allowedTools` is a space-separated list — such a name would not merely
// fail to match, it would split into fragments and corrupt the entries around
// it. Dropping it fails closed, and the tool is simply not granted.
export function buildMcpToolGrants(mcpServerNames: readonly string[] | undefined): string[] {
  if (!mcpServerNames?.length) return [];
  const usable = mcpServerNames.filter(
    (name): name is string => typeof name === "string" && name.length > 0 && !/\s/.test(name),
  );
  return [...new Set(usable)].sort().flatMap((name) => [`mcp__${name}`, `mcp__${name}__*`]);
}
