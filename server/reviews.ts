import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { PullRequestCache, type CacheRecord } from "./cache";
import {
  includePullRequest,
  materializeReviewState,
  matchesNotificationRepository,
  requestedTeamNames,
} from "./filters";
import {
  GitHubError,
  activeViewerLogin,
  fetchPullRequest,
  fetchReviews,
  listReviewNotifications,
  pullRequestEndpoint,
  fetchPullRequestDetail,
  fetchPullRequestDiff,
  submitApproval,
  type NotificationThread,
  type RetryReporter,
} from "./github";
import type {
  approveReview,
  listReviews,
  mapRepository,
  pullRequestDetail,
  PullRequest,
  RefreshEvent,
  RefreshProgress,
  setPullRequestUnread,
} from "../shared/reviews";
import {
  isUnread,
  lastUpdatedCutoff,
  loadReadState,
  loadRepositoryMap,
  loadSettings,
  lookupLegacyRepositoryPath,
  lookupRepositoryMapping,
  readSettingsFile,
  saveReadAt,
  saveRepositoryMapping,
  settingsPath,
} from "./settings";

const cache = new PullRequestCache();

/** Endpoints keyed by PR id, so approve does not re-derive them from a URL. */
const endpoints = new Map<string, string>();

let lastResult: { pullRequests: PullRequest[]; viewer: string | null; fetchedAt: string } | null =
  null;

const IDLE_EVENT: RefreshEvent = { phase: "idle", detail: "", current: 0, total: 0 };
const HISTORY_LIMIT = 50;

let current: RefreshEvent = IDLE_EVENT;
let history: RefreshEvent[] = [];

/**
 * Plugin RPC is request/response, so a refresh cannot stream. The surface polls
 * `reviews.progress` while its own list request is in flight; `history` is what
 * it missed between polls, which is most of a fast refresh.
 */
function report(next: Partial<RefreshEvent>): void {
  current = { ...current, ...next };
  const previous = history.at(-1);
  // Collapse repeats so a run of identical detail lines does not fill the log.
  if (
    previous &&
    previous.phase === current.phase &&
    previous.detail === current.detail &&
    previous.current === current.current
  ) {
    return;
  }
  history.push(current);
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
}

function beginRefresh(): void {
  current = IDLE_EVENT;
  history = [];
}

export function readRefreshProgress(): RefreshProgress {
  return { ...current, history: [...history] };
}

/**
 * Multiple app clients can refresh together. Share their GitHub work and keep
 * the reported progress describing a single refresh.
 */
let inFlight: Promise<RpcOutput<typeof listReviews>> | null = null;

/**
 * Aborted by plugin cleanup. Without it, a `gh` call in flight when Paseo stops
 * the plugin keeps the subprocess alive for its full 45s attempt timeout, then
 * tries to answer over an IPC channel the host already closed — which crashes
 * the subprocess and stalls the reload that asked it to stop.
 */
let shutdown = new AbortController();

export function stopReviews(): void {
  shutdown.abort(new Error("Plugin is stopping"));
}

/** Test seam: a new controller per run, since abort is terminal. */
export function resetShutdownForTests(): void {
  shutdown = new AbortController();
}

function abortAfter(ms: number): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(ms), shutdown.signal]);
}

/** Local state attached to each PR after GitHub data is loaded. */
async function decorate(pullRequests: PullRequest[]): Promise<PullRequest[]> {
  const [map, readState] = await Promise.all([loadRepositoryMap(), loadReadState()]);
  return pullRequests.map((pr) => ({
    ...pr,
    repositoryPath: lookupLegacyRepositoryPath(map, pr.repository),
    projectMapping: lookupRepositoryMapping(map, pr.repository),
    unread: isUnread(readState, pr.id),
  }));
}

function newestThreadPerPullRequest(
  threads: readonly NotificationThread[],
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Map<string, { thread: NotificationThread; endpoint: string; repository: string }> {
  const latest = new Map<
    string,
    { thread: NotificationThread; endpoint: string; repository: string }
  >();
  for (const thread of threads) {
    if (!matchesNotificationRepository(thread.repository?.full_name ?? "", settings)) continue;
    const parsed = pullRequestEndpoint(thread);
    if (!parsed) continue;
    const existing = latest.get(parsed.id);
    if (!existing || Date.parse(thread.updated_at) > Date.parse(existing.thread.updated_at)) {
      latest.set(parsed.id, {
        thread,
        endpoint: parsed.endpoint,
        repository: parsed.repository,
      });
    }
  }
  return latest;
}

export async function list(
  input: RpcInput<typeof listReviews>,
): Promise<RpcOutput<typeof listReviews>> {
  if (shutdown.signal.aborted) throw new Error("Plugin is stopping");
  if (input.cachedOnly) return await runList(input);
  if (inFlight) return await inFlight;
  beginRefresh();
  inFlight = runList(input).finally(() => {
    inFlight = null;
  });
  return await inFlight;
}

async function runList(
  input: RpcInput<typeof listReviews>,
): Promise<RpcOutput<typeof listReviews>> {
  await cache.load();
  const settings = await loadSettings();
  const now = Date.now();

  if (input.cachedOnly) {
    // Deliberately touches nothing but disk: this is the provisional list the
    // surface paints before the authoritative poll returns, so it must not wait
    // on gh — not even to resolve the viewer.
    const pullRequests = cache
      .all()
      .filter((record) =>
        includePullRequest(record.pullRequest, settings, record.viewerApproved, now),
      )
      .map((record) => record.pullRequest);
    return {
      pullRequests: await decorate(sortPullRequests(pullRequests)),
      viewer: lastResult?.viewer ?? null,
      stale: true,
      error: null,
      fetchedAt: new Date(now).toISOString(),
      agentProvider: settings.agentProvider,
      refreshIntervalMs: settings.refreshIntervalMs,
    };
  }

  const signal = abortAfter(180_000);
  const onRetry = ({
    attempt,
    of,
    delayMs,
    reason,
  }: {
    attempt: number;
    of: number;
    delayMs: number;
    reason: string;
  }) => {
    report({
      detail: `${reason} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${of})`,
    });
  };

  report({ phase: "polling", detail: "Requesting review-requested threads", current: 0, total: 0 });
  let threads: NotificationThread[];
  try {
    threads = await listReviewNotifications(lastUpdatedCutoff(settings, now), signal, onRetry);
  } catch (error) {
    report({ phase: "done", detail: "Poll failed — showing cached results", current: 0, total: 0 });
    // A failed poll leaves the cached list visible rather than emptying the UI.
    const cached = cache
      .all()
      .filter((record) =>
        includePullRequest(record.pullRequest, settings, record.viewerApproved, now),
      )
      .map((record) => record.pullRequest);
    return {
      pullRequests: await decorate(sortPullRequests(cached)),
      viewer: lastResult?.viewer ?? null,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: new Date(now).toISOString(),
      agentProvider: settings.agentProvider,
      refreshIntervalMs: settings.refreshIntervalMs,
    };
  }

  report({
    phase: "filtering",
    detail: `${threads.length} ${threads.length === 1 ? "thread" : "threads"} received`,
  });
  const latest = newestThreadPerPullRequest(threads, settings);

  if (latest.size > 0) {
    report({ phase: "identifying", detail: "Checking the active gh account" });
  }
  const viewer = latest.size > 0 ? await activeViewerLogin(signal) : null;
  if (viewer) report({ detail: `Active account @${viewer}` });
  const included: PullRequest[] = [];
  let secondaryLimited = false;

  // Newest first so a capped refresh does the work that matters most.
  const ranked = [...latest.entries()].sort(
    ([, a], [, b]) => Date.parse(b.thread.updated_at) - Date.parse(a.thread.updated_at),
  );
  const candidates = ranked.map(([id, entry], index) => {
    endpoints.set(id, entry.endpoint);
    const cached = cache.get(id);
    const threadUpdatedAt = Date.parse(entry.thread.updated_at);
    const detailsFresh =
      cached !== null &&
      cached.pullRequest.headSha !== "" &&
      threadUpdatedAt <= Date.parse(cached.notificationUpdatedAt);
    const reviewsFresh =
      cached !== null &&
      cached.reviewsUpdatedAt !== null &&
      threadUpdatedAt <= Date.parse(cached.reviewsUpdatedAt) &&
      (viewer === null || cached.reviewViewer?.toLowerCase() === viewer.toLowerCase());
    return { id, entry, index, cached, fresh: detailsFresh && reviewsFresh };
  });
  const pending = candidates.filter((candidate) => !candidate.fresh);
  const refreshCandidates = pending.slice(0, settings.maxDetailFetches);
  const deferred = pending.length - refreshCandidates.length;
  report({ phase: "details", detail: "", current: 0, total: refreshCandidates.length });

  // Each miss costs two serial requests, so a first run over a busy account is
  // dominated by round-trips rather than by GitHub's limits. A small pool cuts
  // that without behaving like a scraper; the secondary-limit bail still stops
  // every worker at once.
  const results: (CacheRecord | null)[] = candidates.map((candidate) => candidate.cached);
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (!secondaryLimited && !signal.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= refreshCandidates.length) return;
      const candidate = refreshCandidates[index];
      if (candidate === undefined) return;
      const { id, entry, cached } = candidate;

      let record: CacheRecord | null = cached;
      try {
        report({ detail: `${id} · fetching details` });
        record = await refresh(entry, cached, viewer, signal, onRetry);
        await cache.put(record, settings.cacheMaxBytes);
      } catch (error) {
        if (error instanceof GitHubError && error.secondaryRateLimited) {
          secondaryLimited = true;
          report({ detail: `${id} · stopping, GitHub secondary rate limit` });
        }
        record = cached;
      }
      results[candidate.index] = record;
      completed += 1;
      report({ current: completed });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(settings.detailConcurrency, refreshCandidates.length) }, () =>
      worker(),
    ),
  );

  for (const record of results) {
    if (!record) continue;
    if (includePullRequest(record.pullRequest, settings, record.viewerApproved, now)) {
      included.push(record.pullRequest);
    }
  }

  const sorted = sortPullRequests(included);
  report({
    phase: "done",
    detail: [
      `${sorted.length} awaiting review`,
      `${completed} ${completed === 1 ? "detail" : "details"} refreshed`,
      deferred > 0 ? `${deferred} queued for a later refresh` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    current: completed,
    total: refreshCandidates.length,
  });
  lastResult = { pullRequests: sorted, viewer, fetchedAt: new Date(now).toISOString() };
  return {
    pullRequests: await decorate(sorted),
    viewer,
    stale: false,
    error: secondaryLimited
      ? "GitHub reported a secondary rate limit; some details are cached."
      : null,
    fetchedAt: lastResult.fetchedAt,
    agentProvider: settings.agentProvider,
    refreshIntervalMs: settings.refreshIntervalMs,
  };
}

async function refresh(
  entry: { thread: NotificationThread; endpoint: string; repository: string },
  cached: CacheRecord | null,
  viewer: string | null,
  signal: AbortSignal,
  onRetry?: RetryReporter,
): Promise<CacheRecord> {
  const pullRequestDetailJson = await fetchPullRequest(entry.endpoint, signal, onRetry);
  const reviews = await fetchReviews(entry.endpoint, signal, onRetry);
  const decision = materializeReviewState(reviews, viewer, pullRequestDetailJson.head?.sha ?? "");
  const pullRequest: PullRequest = {
    id: `${entry.repository}#${pullRequestDetailJson.number}`,
    repository: entry.repository,
    number: pullRequestDetailJson.number,
    title: pullRequestDetailJson.title,
    url: pullRequestDetailJson.html_url,
    author: pullRequestDetailJson.user?.login ?? "",
    isDraft: Boolean(pullRequestDetailJson.draft),
    state: pullRequestDetailJson.state,
    merged: pullRequestDetailJson.merged_at !== null,
    autoMerge:
      pullRequestDetailJson.auto_merge !== null && pullRequestDetailJson.auto_merge !== undefined,
    headSha: pullRequestDetailJson.head?.sha ?? "",
    requestedTeams: requestedTeamNames(pullRequestDetailJson, entry.repository),
    updatedAt: pullRequestDetailJson.updated_at,
    reviewState: decision.state,
    repositoryPath: cached?.pullRequest.repositoryPath ?? null,
    projectMapping: cached?.pullRequest.projectMapping ?? null,
    unread: cached?.pullRequest.unread ?? true,
  };
  return {
    pullRequest,
    notificationUpdatedAt: entry.thread.updated_at,
    reviewsUpdatedAt: entry.thread.updated_at,
    reviewViewer: viewer,
    viewerApproved: decision.viewerApproved,
  };
}

function sortPullRequests(pullRequests: readonly PullRequest[]): PullRequest[] {
  return [...pullRequests].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

export async function setUnread(
  input: RpcInput<typeof setPullRequestUnread>,
): Promise<RpcOutput<typeof setPullRequestUnread>> {
  const record = cache.get(input.id);
  if (!record) throw new Error(`Unknown pull request: ${input.id}`);
  await saveReadAt(input.id, input.unread ? null : record.pullRequest.updatedAt);
  return { id: input.id, unread: input.unread };
}

const detailCache = new Map<string, RpcOutput<typeof pullRequestDetail>>();
const MAX_DIFF_BYTES = 400_000;

export async function detail(
  input: RpcInput<typeof pullRequestDetail>,
): Promise<RpcOutput<typeof pullRequestDetail>> {
  const record = cache.get(input.id);
  const endpoint = endpoints.get(input.id);
  if (!record || !endpoint) throw new Error(`Unknown pull request: ${input.id}`);
  // Keyed by head SHA so a new push invalidates without a manual refresh.
  const key = `${input.id}@${record.pullRequest.headSha}`;
  const memo = detailCache.get(key);
  if (memo) return memo;

  const signal = abortAfter(60_000);
  const [detailJson, diff] = await Promise.all([
    fetchPullRequestDetail(endpoint, signal),
    fetchPullRequestDiff(endpoint, signal),
  ]);
  const truncated = diff.length > MAX_DIFF_BYTES;
  const result = {
    id: input.id,
    body: detailJson.body ?? "",
    diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff,
    diffTruncated: truncated,
    additions: detailJson.additions ?? 0,
    deletions: detailJson.deletions ?? 0,
    changedFiles: detailJson.changed_files ?? 0,
  };
  detailCache.set(key, result);
  return result;
}

export async function approve(
  input: RpcInput<typeof approveReview>,
): Promise<RpcOutput<typeof approveReview>> {
  const endpoint = endpoints.get(input.id);
  if (!endpoint) throw new Error(`Unknown pull request: ${input.id}`);
  await submitApproval(endpoint, abortAfter(60_000));
  // Approving removes it from the list on the next poll; drop it now so the
  // surface does not show a PR the user just cleared.
  const cached = cache.get(input.id);
  if (cached) {
    await cache.put({ ...cached, viewerApproved: true }, (await loadSettings()).cacheMaxBytes);
  }
  return { approved: true };
}

export async function mapRepositoryProject(
  input: RpcInput<typeof mapRepository>,
): Promise<RpcOutput<typeof mapRepository>> {
  const repository = input.repository.trim();
  if (!repository.includes("/")) throw new Error("Repository must be owner/name");
  const mapping = {
    ...input.mapping,
    projectKey: input.mapping.projectKey.trim(),
    projectId: input.mapping.projectId.trim(),
    projectName: input.mapping.projectName.trim(),
    projectRootPath: input.mapping.projectRootPath.trim(),
    serverId: input.mapping.serverId.trim(),
    serverName: input.mapping.serverName.trim(),
  };
  if (
    !mapping.projectKey ||
    !mapping.projectId ||
    !mapping.projectName ||
    !mapping.projectRootPath ||
    !mapping.serverId ||
    !mapping.serverName
  ) {
    throw new Error("Project mapping is incomplete");
  }
  await saveRepositoryMapping(repository, mapping);
  return { repository, mapping };
}

export async function readReviewSettings(): Promise<{ path: string; contents: string | null }> {
  return { path: settingsPath(), contents: await readSettingsFile() };
}
