import {
  getPaseoClient,
  openExternalUrl,
  useRpc,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import { useReviewProjects } from "./use-projects";
import { useReviewList } from "./use-reviews";
import { cancelReviewListQueries, removeReviewedPullRequest, updateReviewUnread } from "./reviews";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import {
  ActionButton,
  ReviewDetail,
  ReviewEmptyDetail,
  ReviewFilterChip,
  ReviewQueueRow,
  type DetailTab,
  type ReviewAction,
  type ReviewQueueFilter,
} from "./card";
import { describeAge, describeEvent, describeProgress, progressFraction } from "../shared/progress";
import {
  approveReview,
  mapRepository,
  pullRequestDetail,
  readProgress,
  type PullRequest,
  type ReviewListResult,
  type RepositoryProjectMapping,
  setPullRequestUnread,
} from "../shared/reviews";
import { createStyles, type Styles } from "./theme";
import {
  resolveProjectPlacement,
  resolveReviewAgentConfig,
  reviewWorkspaceCreateOptions,
} from "./workspace";

/** Fast enough that the per-PR counter visibly moves, cheap enough to leave on. */
const PROGRESS_POLL_MS = 400;
const EMPTY_PULL_REQUESTS: PullRequest[] = [];

interface ActivityLine {
  key: string;
  line: string;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activityLines(lines: string[]): ActivityLine[] {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { key: `${line}-${occurrence}`, line };
  });
}

function queueCountLabel(totalCount: number): string {
  return `${totalCount} ${totalCount === 1 ? "request" : "requests"}`;
}

function queueEmptyTitle(loaded: boolean, refreshing: boolean, filter: ReviewQueueFilter): string {
  if (!loaded || refreshing) return "Loading reviews...";
  return filter === "unread" ? "No unread reviews" : "Nothing waiting";
}

function withRepositoryMapping(
  snapshot: ReviewListResult | undefined,
  repository: string,
  mapping: RepositoryProjectMapping | null,
): ReviewListResult | undefined {
  if (!snapshot) return snapshot;
  const normalizedRepository = repository.toLowerCase();
  let changed = false;
  const pullRequests = snapshot.pullRequests.map((pullRequest) => {
    if (pullRequest.repository.toLowerCase() !== normalizedRepository) return pullRequest;
    changed = true;
    return { ...pullRequest, projectMapping: mapping };
  });
  return changed ? { ...snapshot, pullRequests } : snapshot;
}

interface ReviewQueueProps {
  compact: boolean;
  pullRequests: PullRequest[];
  filter: ReviewQueueFilter;
  selectedId: string | null;
  now: number;
  status: string;
  fraction: number | null;
  listError: string | null;
  showLog: boolean;
  log: ActivityLine[];
  loaded: boolean;
  refreshing: boolean;
  markingAllRead: boolean;
  canMarkAllRead: boolean;
  busyActions: Record<string, ReviewAction>;
  onSelect: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onMarkAllRead: () => void;
  onFilter: (filter: ReviewQueueFilter) => void;
  onToggleLog: () => void;
  onRefresh: () => void;
  styles: Styles;
}

function ReviewQueue({
  compact,
  pullRequests,
  filter,
  selectedId,
  now,
  status,
  fraction,
  listError,
  showLog,
  log,
  loaded,
  refreshing,
  markingAllRead,
  canMarkAllRead,
  busyActions,
  onSelect,
  onMarkUnread,
  onMarkAllRead,
  onFilter,
  onToggleLog,
  onRefresh,
  styles,
}: ReviewQueueProps) {
  const progressStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.trackFill, { width: `${Math.round((fraction ?? 0) * 100)}%` }],
    [fraction, styles.trackFill],
  );
  const countLabel = queueCountLabel(pullRequests.length);
  const emptyTitle = queueEmptyTitle(loaded, refreshing, filter);
  return (
    <View style={compact ? styles.compactPane : styles.queuePane}>
      <View style={styles.queueHeader}>
        <View style={styles.queueTitleRow}>
          <View style={styles.queueTitleGroup}>
            <Text style={styles.queueTitle}>Review queue</Text>
            <Text style={styles.queueCount}>{countLabel}</Text>
          </View>
          <View style={styles.headerActions}>
            <ActionButton
              label={showLog ? "Hide activity" : "Activity"}
              variant="ghost"
              onPress={onToggleLog}
              styles={styles}
            />
            <ActionButton
              label={refreshing ? "Refreshing..." : "Refresh"}
              variant="ghost"
              disabled={refreshing}
              onPress={onRefresh}
              styles={styles}
            />
          </View>
        </View>

        <View style={styles.queueFilterRow}>
          <View style={styles.filterChips} accessibilityRole="tablist">
            <ReviewFilterChip
              filter="unread"
              selected={filter === "unread"}
              onSelect={onFilter}
              styles={styles}
            />
            <ReviewFilterChip
              filter="all"
              selected={filter === "all"}
              onSelect={onFilter}
              styles={styles}
            />
          </View>
          <ActionButton
            label={markingAllRead ? "Marking all as read..." : "Mark all as Read"}
            variant="ghost"
            disabled={markingAllRead || !canMarkAllRead}
            onPress={onMarkAllRead}
            styles={styles}
          />
        </View>

        <View style={styles.statusBlock}>
          <View style={styles.statusRow}>
            <Text style={styles.status} numberOfLines={2}>
              {status}
            </Text>
          </View>
          {fraction === null ? null : (
            <View style={styles.track}>
              <View style={progressStyle} />
            </View>
          )}
          {listError ? <Text style={styles.notice}>{listError}</Text> : null}
          {showLog && log.length > 0 ? (
            <ScrollView style={styles.log}>
              {log.map((entry) => (
                <Text key={entry.key} style={styles.logLine} numberOfLines={1}>
                  {entry.line}
                </Text>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>

      <ScrollView style={styles.queueScroll} contentContainerStyle={styles.queueContent}>
        {pullRequests.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>
              {filter === "unread" ? "Unread" : "All reviews"}
            </Text>
            {pullRequests.map((pullRequest) => (
              <ReviewQueueRow
                key={pullRequest.id}
                pullRequest={pullRequest}
                selected={selectedId === pullRequest.id}
                now={now}
                onSelect={onSelect}
                onMarkUnread={onMarkUnread}
                unreadDisabled={markingAllRead || busyActions[pullRequest.id] !== undefined}
                styles={styles}
              />
            ))}
          </>
        ) : (
          <View style={styles.queueEmpty}>
            <Text style={styles.queueEmptyTitle}>{emptyTitle}</Text>
            <Text style={styles.queueEmptyText}>
              {filter === "unread"
                ? "You are caught up. Open All to revisit read reviews."
                : "New requests will appear here."}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// The surface intentionally keeps query lifecycles and their user-visible states together.
// oxlint-disable-next-line complexity
export function ReviewInbox({ theme, layout, navigation, host }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const fetchProgress = useRpc(readProgress);
  const fetchDetail = useRpc(pullRequestDetail);
  const setUnread = useRpc(setPullRequestUnread);
  const approve = useRpc(approveReview);
  const mapRepositoryProject = useRpc(mapRepository);

  const { projects, status: projectsStatus } = useReviewProjects();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [showLog, setShowLog] = useState(false);
  const [filter, setFilter] = useState<ReviewQueueFilter>("unread");
  const [busyActions, setBusyActions] = useState<Record<string, ReviewAction>>({});
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const markingAllReadRef = useRef(false);
  const [bulkReadError, setBulkReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  const { reviews, snapshot, showingCache, unreadCount } = useReviewList(host.id);

  const progress = useQuery({
    queryKey: ["reviews", "progress"],
    queryFn: () => fetchProgress({}),
    refetchInterval: reviews.isFetching ? PROGRESS_POLL_MS : false,
    retry: false,
  });

  const detail = useQuery({
    queryKey: ["reviews", "detail", selectedId],
    queryFn: () => fetchDetail({ id: selectedId ?? "" }),
    enabled: selectedId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const wasFetching = useRef(false);
  const refetchProgress = progress.refetch;
  useEffect(() => {
    if (wasFetching.current && !reviews.isFetching) void refetchProgress();
    wasFetching.current = reviews.isFetching;
  }, [refetchProgress, reviews.isFetching]);

  const pullRequests = snapshot?.pullRequests ?? EMPTY_PULL_REQUESTS;
  const filteredPullRequests = useMemo(
    () =>
      filter === "unread"
        ? pullRequests.filter((pullRequest) => pullRequest.unread || pullRequest.id === selectedId)
        : pullRequests,
    [filter, pullRequests, selectedId],
  );
  const selectedPullRequest =
    pullRequests.find((pullRequest) => pullRequest.id === selectedId) ?? null;
  const selectedPlacement = useMemo(
    () => resolveProjectPlacement(projects, selectedPullRequest?.projectMapping),
    [projects, selectedPullRequest?.projectMapping],
  );

  useEffect(() => {
    if (selectedId && snapshot && !selectedPullRequest) {
      setSelectedId(null);
      setActionError(null);
    }
  }, [selectedId, selectedPullRequest, snapshot]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["reviews"], exact: true });
  }, [queryClient]);

  const updateMappingCache = useCallback(
    (repository: string, mapping: RepositoryProjectMapping | null) => {
      const update = (current: ReviewListResult | undefined) =>
        withRepositoryMapping(current, repository, mapping);
      queryClient.setQueryData<ReviewListResult>(["reviews"], update);
      queryClient.setQueryData<ReviewListResult>(["reviews", "cached"], update);
    },
    [queryClient],
  );

  const updateUnreadCache = useCallback(
    (id: string, unread: boolean) => {
      updateReviewUnread(queryClient, { id, unread });
    },
    [queryClient],
  );

  const runAction = useCallback(
    async (id: string, action: ReviewAction, operation: () => Promise<void>): Promise<boolean> => {
      setBusyActions((current) => ({ ...current, [id]: action }));
      setActionError(null);
      try {
        await operation();
        return true;
      } catch (error) {
        setActionError({ id, message: messageFrom(error) });
        return false;
      } finally {
        setBusyActions((current) => {
          if (current[id] !== action) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    },
    [],
  );

  const configuredAgentProvider = snapshot?.agentProvider ?? "claude";
  const open = useCallback(
    async (pullRequest: PullRequest) => {
      await runAction(pullRequest.id, "worktree", async () => {
        const placement = resolveProjectPlacement(projects, pullRequest.projectMapping);
        if (!placement) throw new Error("Choose an available Paseo project first.");
        if (!navigation) throw new Error("Update the Paseo app to open review workspaces.");
        const paseoHost = getPaseoClient(placement.serverId);
        const agentConfig = await resolveReviewAgentConfig(paseoHost, {
          projectKey: placement.projectKey,
          cwd: placement.projectRootPath,
          fallbackProvider: configuredAgentProvider,
        });
        const workspace = await paseoHost.workspaces.create(
          reviewWorkspaceCreateOptions(pullRequest, placement),
        );
        const agent = await workspace.agents.create({
          config: agentConfig,
          prompt: [
            `Review the checked-out pull request ${pullRequest.id}: ${pullRequest.title}`,
            "",
            "The PR branch is already checked out in this worktree. Inspect the local files, commits, and diff rather than fetching the PR with GitHub CLI.",
            "Summarise what the change does, then wait for my questions about the implementation.",
          ].join("\n"),
        });
        navigation.openAgent({ agentId: agent.id, serverId: placement.serverId });
      });
    },
    [configuredAgentProvider, navigation, projects, runAction],
  );

  const approvePullRequest = useCallback(
    async (pullRequest: PullRequest) => {
      const succeeded = await runAction(pullRequest.id, "approve", async () => {
        await approve({ id: pullRequest.id });
        await cancelReviewListQueries(queryClient);
        removeReviewedPullRequest(queryClient, pullRequest.id);
      });
      if (!succeeded) return;
      // Approval may finish after the user has opened another PR.
      setSelectedId((current) => (current === pullRequest.id ? null : current));
      refresh();
    },
    [approve, queryClient, refresh, runAction],
  );

  const saveUnread = useCallback(
    async (pullRequest: PullRequest, unread: boolean) => {
      const previous = pullRequest.unread;
      await cancelReviewListQueries(queryClient);
      updateUnreadCache(pullRequest.id, unread);
      try {
        const saved = await setUnread({ id: pullRequest.id, unread });
        // A poll can start while the write is pending and capture the old flag.
        await cancelReviewListQueries(queryClient);
        updateUnreadCache(saved.id, saved.unread);
      } catch (error) {
        await cancelReviewListQueries(queryClient);
        updateUnreadCache(pullRequest.id, previous);
        throw error;
      }
    },
    [queryClient, setUnread, updateUnreadCache],
  );

  const markAllRead = useCallback(async () => {
    if (markingAllReadRef.current) return;
    markingAllReadRef.current = true;
    setMarkingAllRead(true);
    setBulkReadError(null);
    setActionError(null);
    // A selected read PR is kept in Unread while reviewing. Explicitly clearing
    // the queue also releases that selection, even when the unread count is zero.
    setSelectedId(null);
    try {
      const unread = pullRequests.filter((pullRequest) => pullRequest.unread);
      const results = await Promise.allSettled(
        unread.map((pullRequest) => saveUnread(pullRequest, false)),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        setBulkReadError(
          `Could not mark ${failures.length} ${failures.length === 1 ? "review" : "reviews"} as read: ${messageFrom(failures[0].reason)}`,
        );
      }
    } finally {
      markingAllReadRef.current = false;
      setMarkingAllRead(false);
    }
  }, [pullRequests, saveUnread]);

  const markUnread = useCallback(
    (id: string) => {
      const pullRequest = pullRequests.find((candidate) => candidate.id === id);
      if (!pullRequest || pullRequest.unread || markingAllReadRef.current || busyActions[id]) {
        return;
      }
      void runAction(id, "unread", () => saveUnread(pullRequest, true));
    },
    [busyActions, pullRequests, runAction, saveUnread],
  );

  const saveMapping = useCallback(
    async (pullRequest: PullRequest, mapping: RepositoryProjectMapping) => {
      const previousMapping = pullRequest.projectMapping;
      updateMappingCache(pullRequest.repository, mapping);
      const succeeded = await runAction(pullRequest.id, "map", async () => {
        const saved = await mapRepositoryProject({ repository: pullRequest.repository, mapping });
        updateMappingCache(saved.repository, saved.mapping);
      });
      if (!succeeded) updateMappingCache(pullRequest.repository, previousMapping);
    },
    [mapRepositoryProject, runAction, updateMappingCache],
  );

  const selectPullRequest = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDetailTab("overview");
      setActionError(null);
      const pullRequest = pullRequests.find((candidate) => candidate.id === id);
      if (!pullRequest?.unread) return;
      void runAction(id, "read", () => saveUnread(pullRequest, false));
    },
    [pullRequests, runAction, saveUnread],
  );
  const backToQueue = useCallback(() => {
    setSelectedId(null);
    setActionError(null);
  }, []);
  const toggleLog = useCallback(() => setShowLog((shown) => !shown), []);

  const activity = reviews.isFetching ? describeProgress(progress.data) : null;
  const fraction = reviews.isFetching ? progressFraction(progress.data) : null;
  const age = describeAge(snapshot?.fetchedAt, Date.now());
  const idleStatus = snapshot
    ? [
        snapshot.stale ? "Showing cached results" : `Updated ${age ?? "recently"}`,
        `${unreadCount} unread`,
      ].join(" · ")
    : "Loading reviews...";
  const status = reviews.isFetching
    ? [activity ?? "Refreshing...", showingCache ? "showing cached results" : null]
        .filter(Boolean)
        .join(" · ")
    : idleStatus;
  const log = useMemo(
    () => activityLines((progress.data?.history ?? []).map(describeEvent).filter(Boolean)),
    [progress.data],
  );
  const listError =
    bulkReadError ?? actionError?.message ??
    (reviews.error ? messageFrom(reviews.error) : (snapshot?.error ?? null));
  const now = Date.now();

  const openSelectedWorkspace = useCallback(() => {
    if (selectedPullRequest) void open(selectedPullRequest);
  }, [open, selectedPullRequest]);
  const openSelectedUrl = useCallback(() => {
    if (!selectedPullRequest) return;
    void openExternalUrl(selectedPullRequest.url).catch((error) => {
      setActionError({ id: selectedPullRequest.id, message: messageFrom(error) });
    });
  }, [selectedPullRequest]);
  const approveSelected = useCallback(() => {
    if (selectedPullRequest) void approvePullRequest(selectedPullRequest);
  }, [approvePullRequest, selectedPullRequest]);
  const markSelectedUnread = useCallback(() => {
    if (selectedPullRequest) markUnread(selectedPullRequest.id);
  }, [markUnread, selectedPullRequest]);
  const mapSelected = useCallback(
    (mapping: RepositoryProjectMapping) => {
      if (selectedPullRequest) void saveMapping(selectedPullRequest, mapping);
    },
    [saveMapping, selectedPullRequest],
  );

  const queue = (
    <ReviewQueue
      compact={layout.compact}
      pullRequests={filteredPullRequests}
      filter={filter}
      selectedId={selectedId}
      now={now}
      status={status}
      fraction={fraction}
      listError={listError}
      showLog={showLog}
      log={log}
      loaded={snapshot !== undefined}
      refreshing={reviews.isFetching}
      markingAllRead={markingAllRead}
      canMarkAllRead={unreadCount > 0 || (filter === "unread" && selectedPullRequest !== null)}
      busyActions={busyActions}
      onSelect={selectPullRequest}
      onMarkUnread={markUnread}
      onMarkAllRead={markAllRead}
      onFilter={setFilter}
      onToggleLog={toggleLog}
      onRefresh={refresh}
      styles={styles}
    />
  );

  const selectedDetail = selectedPullRequest ? (
    <ReviewDetail
      key={selectedPullRequest.id}
      compact={layout.compact}
      pullRequest={selectedPullRequest}
      detail={detail.data ?? null}
      detailLoading={detail.isFetching}
      detailError={detail.error}
      detailTab={detailTab}
      now={now}
      busyAction={busyActions[selectedPullRequest.id] ?? (markingAllRead ? "read" : null)}
      actionError={actionError?.id === selectedPullRequest.id ? actionError.message : null}
      projects={projects}
      projectsStatus={projectsStatus}
      canOpenWorkspace={navigation !== undefined}
      selectedPlacement={selectedPlacement}
      onBack={layout.compact ? backToQueue : undefined}
      onSelectTab={setDetailTab}
      onOpenWorkspace={openSelectedWorkspace}
      onOpenUrl={openSelectedUrl}
      onApprove={approveSelected}
      onMarkUnread={markSelectedUnread}
      onMap={mapSelected}
      styles={styles}
    />
  ) : null;

  if (layout.compact) {
    return <View style={styles.screen}>{selectedDetail ?? queue}</View>;
  }
  return (
    <View style={styles.screen}>
      <View style={styles.split}>
        {queue}
        {selectedDetail ?? (
          <View style={styles.detailPane}>
            <ReviewEmptyDetail count={filteredPullRequests.length} styles={styles} />
          </View>
        )}
      </View>
    </View>
  );
}
