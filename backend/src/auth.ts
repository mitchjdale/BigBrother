import { config } from "./config.js";

export type TokenKind = "classic" | "fine-grained" | "oauth" | "none";

/**
 * Classify a GitHub token by prefix. Different Copilot tools accept different
 * kinds, so we route (or withhold) credentials per subprocess:
 *   - classic PAT (ghp_)        → rejected by the Copilot CLI and agent-task
 *   - fine-grained PAT (github_pat_) → OK for Copilot CLI, NOT for agent-task
 *   - OAuth (gho_/ghu_/ghs_)    → OK everywhere (this is what `gh auth login` yields)
 */
export function tokenKind(token: string): TokenKind {
  if (!token) return "none";
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("gho_") || token.startsWith("ghu_") || token.startsWith("ghs_")) return "oauth";
  if (token.startsWith("ghp_")) return "classic";
  return "classic"; // unknown → treat conservatively
}

function stripGitHubTokens(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...base };
  delete e.GH_TOKEN;
  delete e.GITHUB_TOKEN;
  return e;
}

function withGitHubTokens(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return { ...base, GH_TOKEN: token, GITHUB_TOKEN: token };
}

/**
 * git clone URL. Public repos clone anonymously (no token) so any collaborator
 * can plan against them regardless of their own token's scope. Private repos
 * embed the token if we have one.
 */
export function cloneUrl(owner: string, name: string, base = config.ghToken): string {
  const anonymous = `https://github.com/${owner}/${name}.git`;
  if (!config.repoPrivate || !base) return anonymous;
  return `https://x-access-token:${base}@github.com/${owner}/${name}.git`;
}

/**
 * Environment for the Copilot CLI (planning). Pass the token only if it's a
 * fine-grained PAT or OAuth token; otherwise strip it so the CLI uses its own
 * stored login (`copilot /login` / `gh auth login`). Classic PATs are unsupported.
 */
export function copilotEnv(): NodeJS.ProcessEnv {
  const kind = tokenKind(config.ghToken);
  const base =
    kind === "fine-grained" || kind === "oauth"
      ? withGitHubTokens(process.env, config.ghToken)
      : stripGitHubTokens(process.env);
  return { ...base, COPILOT_DISABLE_UPDATE_CHECK: "1" };
}

/**
 * Environment for `gh agent-task` (execution). This command requires an OAuth
 * token. Pass the token only if it's OAuth; otherwise strip GH_TOKEN so gh uses
 * its keyring credentials from `gh auth login` (which must be a browser/OAuth
 * login, not a PAT).
 */
export function ghAgentEnv(): NodeJS.ProcessEnv {
  return tokenKind(config.ghToken) === "oauth"
    ? withGitHubTokens(process.env, config.ghToken)
    : stripGitHubTokens(process.env);
}
