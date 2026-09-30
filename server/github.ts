import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ATTEMPT_TIMEOUT_MS = 45_000;
// A paginated sweep is one `gh` invocation covering many HTTP requests, so the
// single-resource timeout kills it mid-walk and the retry starts over.
const PAGINATED_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const READ_RETRIES = 4;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface NotificationThread {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string; type: string };
  repository: { full_name: string };
}

export interface RestPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  draft: boolean;
  state: string;
  merged_at: string | null;
  auto_merge: unknown;
  head: { sha: string };
  requested_teams?: { slug: string; organization?: { login: string } }[];
  updated_at: string;
}

export interface RestReview {
  user: { login: string } | null;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}

export class GitHubError extends Error {
  readonly secondaryRateLimited: boolean;
  readonly timedOut: boolean;

  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
    const lowered = message.toLowerCase();
    this.secondaryRateLimited =
      lowered.includes("secondary rate limit") || lowered.includes("abuse detection");
    this.timedOut = lowered.includes("etimedout") || lowered.includes("timeout");
  }

  /** One line naming the real failure; the UI used to call everything throttling. */
  summary(): string {
    if (this.secondaryRateLimited) return "GitHub secondary rate limit";
    if (this.timedOut) return "the request timed out";
    const [first = ""] = this.message.split("\n");
    return first.trim() || "gh failed";
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function retryAfterMs(message: string): number | null {
  const match = /retry-after:\s*([0-9]+)/i.exec(message);
  return match ? Number(match[1]) * 1000 : null;
}

async function attempt(
  args: string[],
  signal: AbortSignal,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await run("gh", args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal });
  return stdout;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reports a pending retry so a stalled refresh does not look frozen. */
export type RetryReporter = (retry: {
  attempt: number;
  of: number;
  delayMs: number;
  reason: string;
}) => void;

/**
 * Read-only requests retry with exponential backoff; an explicit Retry-After
 * from GitHub wins. Mutating requests never retry, because replaying them can
 * duplicate an action.
 */
async function readWithRetry(
  args: string[],
  signal: AbortSignal,
  onRetry?: RetryReporter,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
): Promise<string> {
  let lastError: GitHubError | null = null;
  for (let retry = 0; retry <= READ_RETRIES; retry += 1) {
    if (signal.aborted) throw new Error("Cancelled");
    try {
      return await attempt(args, signal, timeoutMs);
    } catch (error) {
      lastError = new GitHubError(describe(error));
      if (retry === READ_RETRIES || lastError.secondaryRateLimited) break;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** retry);
      const delayMs = retryAfterMs(lastError.message) ?? backoff;
      onRetry?.({
        attempt: retry + 1,
        of: READ_RETRIES,
        delayMs,
        reason: lastError.summary(),
      });
      await sleep(delayMs, signal);
    }
  }
  throw lastError ?? new GitHubError("gh failed");
}

function parseSlurped<T>(stdout: string): T[] {
  const pages = JSON.parse(stdout) as T[][];
  return pages.flat();
}

export async function listReviewNotifications(
  since: number | null,
  signal: AbortSignal,
  onRetry?: RetryReporter,
): Promise<NotificationThread[]> {
  const args = ["api", "notifications", "--method", "GET", "-f", "all=true", "-f", "per_page=100"];
  if (since !== null) {
    args.push("-f", `since=${new Date(since).toISOString()}`);
  }
  args.push("--paginate", "--slurp");
  const threads = parseSlurped<NotificationThread>(
    await readWithRetry(args, signal, onRetry, PAGINATED_TIMEOUT_MS),
  );
  // The REST endpoint exposes reason and subject type as fields rather than
  // query parameters, so these two predicates are applied locally.
  return threads.filter(
    (thread) => thread.reason === "review_requested" && thread.subject?.type === "PullRequest",
  );
}

export interface PullRequestEndpoint {
  id: string;
  endpoint: string;
  repository: string;
  number: number;
}

export function pullRequestEndpoint(thread: NotificationThread): PullRequestEndpoint | null {
  let path: string;
  try {
    path = new URL(thread.subject.url).pathname;
  } catch {
    return null;
  }
  const segments = path.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 5 || segments[0] !== "repos" || segments[3] !== "pulls") return null;
  const number = Number(segments[4]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const repository = thread.repository?.full_name || `${segments[1]}/${segments[2]}`;
  return { id: `${repository}#${number}`, endpoint: segments.join("/"), repository, number };
}

export async function fetchPullRequest(
  endpoint: string,
  signal: AbortSignal,
  onRetry?: RetryReporter,
): Promise<RestPullRequest> {
  const stdout = await readWithRetry(["api", endpoint, "--method", "GET"], signal, onRetry);
  return JSON.parse(stdout) as RestPullRequest;
}

export async function fetchReviews(
  endpoint: string,
  signal: AbortSignal,
  onRetry?: RetryReporter,
): Promise<RestReview[]> {
  const stdout = await readWithRetry(
    [
      "api",
      `${endpoint}/reviews`,
      "--method",
      "GET",
      "-f",
      "per_page=100",
      "--paginate",
      "--slurp",
    ],
    signal,
    onRetry,
  );
  return parseSlurped<RestReview>(stdout);
}

export interface RestPullRequestDetail extends RestPullRequest {
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export async function fetchPullRequestDetail(
  endpoint: string,
  signal: AbortSignal,
): Promise<RestPullRequestDetail> {
  const stdout = await readWithRetry(["api", endpoint, "--method", "GET"], signal);
  return JSON.parse(stdout) as RestPullRequestDetail;
}

export async function fetchPullRequestDiff(endpoint: string, signal: AbortSignal): Promise<string> {
  // The diff media type returns text, so this one is not JSON-parsed.
  return await readWithRetry(
    ["api", endpoint, "--method", "GET", "-H", "Accept: application/vnd.github.v3.diff"],
    signal,
  );
}

export async function submitApproval(endpoint: string, signal: AbortSignal): Promise<void> {
  // Deliberately not retried: a replayed approval can duplicate the action.
  await attempt(
    ["api", `${endpoint}/reviews`, "--method", "POST", "-f", "event=APPROVE"],
    signal,
  ).catch((error) => {
    throw new GitHubError(describe(error));
  });
}

let cachedViewer: string | null = null;

/** Resolved once from the local gh session. Not GraphQL. */
export async function activeViewerLogin(signal: AbortSignal): Promise<string | null> {
  if (cachedViewer) return cachedViewer;
  try {
    const stdout = await attempt(
      [
        "auth",
        "status",
        "--active",
        "--hostname",
        "github.com",
        "--json",
        "hosts",
        "--jq",
        `.hosts["github.com"][] | select(.active) | .login`,
      ],
      signal,
    );
    const login = stdout.trim();
    cachedViewer = login || null;
    return cachedViewer;
  } catch {
    return null;
  }
}
