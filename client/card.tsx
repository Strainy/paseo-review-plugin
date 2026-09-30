import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type AccessibilityState,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { ProjectPlacement, ReviewProject } from "./projects";
import { parseUnifiedDiff, type DiffFileSection, type DiffTone } from "../shared/diff";
import type { PullRequest, RepositoryProjectMapping } from "../shared/reviews";
import type { Styles } from "./theme";

export type DetailTab = "overview" | "diff";
export type ReviewAction = "approve" | "map" | "read" | "unread" | "worktree";
export type ReviewQueueFilter = "unread" | "all";

export interface PullRequestDetail {
  id: string;
  body: string;
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
}

const DISABLED_STYLE = { opacity: 0.42 } as const;

export function relativeAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 28) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

function reviewStateLabel(pullRequest: PullRequest): string | null {
  if (pullRequest.isDraft) return "Draft";
  if (pullRequest.reviewState === "changes-requested") return "Changes requested";
  if (pullRequest.reviewState === "approved") return "Approved";
  if (!pullRequest.projectMapping) return "Choose project";
  return null;
}

function reviewStatusLabel(pullRequest: PullRequest): string {
  if (pullRequest.isDraft) return "Draft";
  if (pullRequest.reviewState === "changes-requested") return "Changes requested";
  if (pullRequest.reviewState === "approved") return "Approved";
  return "Open";
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function ReviewMark({ styles }: { styles: Styles }) {
  return (
    <View style={styles.reviewMark} accessibilityElementsHidden>
      <View style={styles.reviewMarkLine} />
      <View style={styles.reviewMarkBranch} />
      <View style={styles.reviewMarkDotTop} />
      <View style={styles.reviewMarkDotBottom} />
      <View style={styles.reviewMarkDotBranch} />
    </View>
  );
}

interface SurfacePressableProps {
  style: StyleProp<ViewStyle>;
  hoveredStyle?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  onPress: () => void;
  children: ReactNode;
}

function SurfacePressable({
  style,
  hoveredStyle,
  pressedStyle,
  disabled = false,
  accessibilityLabel,
  accessibilityState,
  onPress,
  children,
}: SurfacePressableProps) {
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const resolveStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      style,
      hovered && !disabled ? hoveredStyle : null,
      pressed && !disabled ? pressedStyle : null,
      disabled ? DISABLED_STYLE : null,
    ],
    [disabled, hovered, hoveredStyle, pressedStyle, style],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      onPress={onPress}
      style={resolveStyle}
    >
      {children}
    </Pressable>
  );
}

export function ReviewFilterChip({
  filter,
  selected,
  onSelect,
  styles,
}: {
  filter: ReviewQueueFilter;
  selected: boolean;
  onSelect: (filter: ReviewQueueFilter) => void;
  styles: Styles;
}) {
  const label = filter === "unread" ? "Unread" : "All";
  const select = useCallback(() => onSelect(filter), [filter, onSelect]);
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.filterChip, selected ? styles.filterChipSelected : null],
    [selected, styles],
  );
  const textStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.filterChipText, selected ? styles.filterChipTextSelected : null],
    [selected, styles],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <SurfacePressable
      accessibilityLabel={`Show ${label.toLowerCase()} reviews`}
      accessibilityState={accessibilityState}
      onPress={select}
      style={containerStyle}
      hoveredStyle={styles.filterChipHovered}
      pressedStyle={styles.filterChipPressed}
    >
      <Text style={textStyle}>{label}</Text>
    </SurfacePressable>
  );
}

export function ActionButton({
  label,
  variant = "secondary",
  disabled = false,
  onPress,
  styles,
}: {
  label: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  onPress: () => void;
  styles: Styles;
}) {
  const primary = variant === "primary";
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.button,
      primary ? styles.buttonPrimary : null,
      variant === "ghost" ? styles.buttonGhost : null,
    ],
    [primary, styles, variant],
  );
  const textStyle = useMemo<StyleProp<TextStyle>>(
    () => [
      styles.buttonText,
      primary ? styles.buttonPrimaryText : null,
      variant === "ghost" ? styles.buttonMutedText : null,
      variant === "danger" ? styles.buttonDangerText : null,
    ],
    [primary, styles, variant],
  );
  return (
    <SurfacePressable
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={containerStyle}
      hoveredStyle={primary ? styles.buttonPrimaryHovered : styles.buttonHovered}
      pressedStyle={primary ? styles.buttonPrimaryHovered : styles.buttonPressed}
    >
      <Text style={textStyle}>{label}</Text>
    </SurfacePressable>
  );
}

export function ReviewQueueRow({
  pullRequest,
  selected,
  now,
  onSelect,
  styles,
}: {
  pullRequest: PullRequest;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
  styles: Styles;
}) {
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => onSelect(pullRequest.id), [onSelect, pullRequest.id]);
  const stateLabel = reviewStateLabel(pullRequest);
  const danger = pullRequest.reviewState === "changes-requested";
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const stateStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.reviewState, danger ? styles.reviewStateDanger : null],
    [danger, styles],
  );
  const titleStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.reviewTitle, pullRequest.unread ? styles.reviewTitleUnread : null],
    [pullRequest.unread, styles],
  );
  const resolveStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.reviewRow,
      hovered ? styles.reviewRowHovered : null,
      pressed ? styles.reviewRowPressed : null,
      selected ? styles.reviewRowSelected : null,
    ],
    [hovered, selected, styles],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pullRequest.unread ? "Unread " : ""}review ${pullRequest.repository} pull request ${pullRequest.number}: ${pullRequest.title}`}
      accessibilityState={accessibilityState}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      onPress={handlePress}
      style={resolveStyle}
    >
      <ReviewMark styles={styles} />
      <View style={styles.reviewRowBody}>
        <View style={styles.reviewRowTop}>
          <Text style={titleStyle} numberOfLines={2}>
            {pullRequest.title}
          </Text>
          {pullRequest.unread ? <View style={styles.reviewUnreadDot} /> : null}
          <Text style={styles.reviewAge}>{relativeAge(pullRequest.updatedAt, now)}</Text>
        </View>
        <View style={styles.reviewMetaRow}>
          <Text style={styles.reviewMeta} numberOfLines={1}>
            {pullRequest.repository}#{pullRequest.number}
          </Text>
          <Text style={styles.reviewMeta}>@{pullRequest.author}</Text>
          {stateLabel ? <Text style={stateStyle}>{stateLabel}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

function DetailTabButton({
  tab,
  selected,
  onSelect,
  styles,
}: {
  tab: DetailTab;
  selected: boolean;
  onSelect: (tab: DetailTab) => void;
  styles: Styles;
}) {
  const label = tab === "overview" ? "Overview" : "Diff";
  const handlePress = useCallback(() => onSelect(tab), [onSelect, tab]);
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.tab, selected ? styles.tabSelected : null],
    [selected, styles],
  );
  const textStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.tabText, selected ? styles.tabTextSelected : null],
    [selected, styles],
  );
  return (
    <SurfacePressable
      accessibilityLabel={`Show ${label.toLowerCase()}`}
      onPress={handlePress}
      style={containerStyle}
      hoveredStyle={styles.tabHovered}
      pressedStyle={styles.tabSelected}
    >
      <Text style={textStyle}>{label}</Text>
    </SurfacePressable>
  );
}

function DiffLine({ line, tone, styles }: { line: string; tone: DiffTone; styles: Styles }) {
  const lineStyle = useMemo<StyleProp<TextStyle>>(() => {
    let toneStyle: TextStyle | null = null;
    if (tone === "meta") toneStyle = styles.diffLineMeta;
    if (tone === "add") toneStyle = styles.diffLineAdd;
    if (tone === "remove") toneStyle = styles.diffLineRemove;
    return [styles.diffLine, toneStyle];
  }, [styles, tone]);
  return <Text style={lineStyle}>{line || " "}</Text>;
}

function DiffFile({ file, styles }: { file: DiffFileSection; styles: Styles }) {
  const [expanded, setExpanded] = useState(true);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View style={styles.diffFile}>
      <SurfacePressable
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} changes for ${file.path}`}
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.diffFileHeader}
        hoveredStyle={styles.diffFileHeaderHovered}
        pressedStyle={styles.diffFileHeaderPressed}
      >
        <Text style={styles.diffFileChevron}>{expanded ? "▾" : "▸"}</Text>
        <Text style={styles.diffFileName} numberOfLines={1}>
          {file.path}
        </Text>
        <View style={styles.diffFileStats}>
          {file.additions > 0 ? (
            <Text style={styles.diffFileAdditions}>+{file.additions}</Text>
          ) : null}
          {file.deletions > 0 ? (
            <Text style={styles.diffFileDeletions}>−{file.deletions}</Text>
          ) : null}
        </View>
      </SurfacePressable>
      {expanded ? (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View style={styles.diffCode}>
            {file.lines.map((entry) => (
              <DiffLine key={entry.key} line={entry.line} tone={entry.tone} styles={styles} />
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

function DiffView({ detail, styles }: { detail: PullRequestDetail; styles: Styles }) {
  const files = useMemo(() => parseUnifiedDiff(detail.diff), [detail.diff]);
  if (detail.diff.trim().length === 0) {
    return <Text style={styles.bodyEmpty}>No diff is available for this pull request.</Text>;
  }
  return (
    <View style={styles.diffFiles}>
      {files.map((file) => (
        <DiffFile key={file.key} file={file} styles={styles} />
      ))}
      {detail.diffTruncated ? (
        <Text style={styles.diffNotice}>
          The diff is truncated. Open it on GitHub to see the rest.
        </Text>
      ) : null}
    </View>
  );
}

export function ReviewEmptyDetail({ count, styles }: { count: number; styles: Styles }) {
  let description = "New review requests will appear here.";
  if (count > 0) {
    const subject = count === 1 ? "review is" : "reviews are";
    description = `${count} ${subject} waiting in your queue.`;
  }
  return (
    <View style={styles.emptyDetail}>
      <View style={styles.emptyGraphic}>
        <Text style={styles.emptyGraphicText}>⑂</Text>
      </View>
      <Text style={styles.emptyDetailTitle}>Select a review</Text>
      <Text style={styles.emptyDetailText}>{description}</Text>
    </View>
  );
}

interface ReviewDetailProps {
  compact: boolean;
  pullRequest: PullRequest;
  detail: PullRequestDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  detailTab: DetailTab;
  now: number;
  busyAction: ReviewAction | null;
  actionError: string | null;
  onBack?: () => void;
  onSelectTab: (tab: DetailTab) => void;
  onOpenWorkspace: () => void;
  onOpenUrl: () => void;
  onApprove: () => void;
  onMarkUnread: () => void;
  projects: readonly ReviewProject[];
  projectsStatus: string | null;
  selectedPlacement: ProjectPlacement | null;
  canOpenWorkspace: boolean;
  onMap: (mapping: RepositoryProjectMapping) => void;
  styles: Styles;
}

function projectMapping(
  project: ReviewProject,
  placement: ProjectPlacement,
): RepositoryProjectMapping {
  return {
    projectKey: project.projectKey,
    projectId: placement.projectId,
    projectName: project.projectName,
    projectRootPath: placement.projectRootPath,
    serverId: placement.serverId,
    serverName: placement.serverName,
  };
}

function ProjectPlacementOption({
  project,
  placement,
  selected,
  onSelect,
  styles,
}: {
  project: ReviewProject;
  placement: ProjectPlacement;
  selected: boolean;
  onSelect: (mapping: RepositoryProjectMapping) => void;
  styles: Styles;
}) {
  const choose = useCallback(
    () => onSelect(projectMapping(project, placement)),
    [onSelect, placement, project],
  );
  return (
    <SurfacePressable
      accessibilityLabel={`Use ${project.projectName} on ${placement.serverName}`}
      onPress={choose}
      style={styles.projectPickerOption}
      hoveredStyle={styles.projectPickerOptionHovered}
      pressedStyle={styles.projectPickerOptionPressed}
    >
      <View style={styles.projectPickerOptionBody}>
        <View style={styles.projectPickerOptionTitleRow}>
          <Text style={styles.projectPickerOptionTitle}>{placement.serverName}</Text>
          {!placement.isOnline ? <Text style={styles.projectPickerOffline}>Offline</Text> : null}
        </View>
        <Text style={styles.projectPickerOptionPath} numberOfLines={1}>
          {placement.projectRootPath}
        </Text>
      </View>
      <Text style={styles.projectPickerCheck}>{selected ? "✓" : ""}</Text>
    </SurfacePressable>
  );
}

function ProjectPicker({
  projects,
  projectsStatus,
  value,
  disabled,
  saving,
  onSelect,
  styles,
}: {
  projects: readonly ReviewProject[];
  projectsStatus: string | null;
  value: RepositoryProjectMapping | null;
  disabled: boolean;
  saving: boolean;
  onSelect: (mapping: RepositoryProjectMapping) => void;
  styles: Styles;
}) {
  const [open, setOpen] = useState(false);
  const gitProjects = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          placements: project.placements.filter(
            (placement) =>
              placement.projectKind === "git" && placement.projectRootPath.trim().length > 0,
          ),
        }))
        .filter(({ placements }) => placements.length > 0),
    [projects],
  );
  const toggle = useCallback(() => setOpen((shown) => !shown), []);
  const noProjects = gitProjects.length === 0 && projectsStatus === null;
  const selectedLabel = value ? value.projectName : "Choose a Paseo project";
  let selectedDetail = value ? `${value.serverName} · ${value.projectRootPath}` : "All hosts";
  if (saving) selectedDetail = value ? `${value.serverName} · Saving...` : "Saving project...";
  let chevron = open ? "⌃" : "⌄";
  if (saving) chevron = "…";
  const choose = useCallback(
    (mapping: RepositoryProjectMapping) => {
      setOpen(false);
      onSelect(mapping);
    },
    [onSelect],
  );

  return (
    <View style={styles.projectPicker}>
      <SurfacePressable
        accessibilityLabel={`Project mapping: ${selectedLabel}`}
        disabled={disabled}
        onPress={toggle}
        style={styles.projectPickerTrigger}
        hoveredStyle={styles.projectPickerTriggerHovered}
        pressedStyle={styles.projectPickerTriggerPressed}
      >
        <View style={styles.projectPickerLabelGroup}>
          <Text style={value ? styles.projectPickerLabel : styles.projectPickerPlaceholder}>
            {selectedLabel}
          </Text>
          <Text style={styles.projectPickerDetail} numberOfLines={1}>
            {selectedDetail}
          </Text>
        </View>
        <Text style={styles.projectPickerChevron}>{chevron}</Text>
      </SurfacePressable>

      {open ? (
        <View style={styles.projectPickerMenu}>
          <ScrollView style={styles.projectPickerScroll} nestedScrollEnabled>
            {projectsStatus ? (
              <Text style={styles.projectPickerEmpty}>{projectsStatus}</Text>
            ) : null}
            {noProjects ? (
              <Text style={styles.projectPickerEmpty}>No Git projects are available.</Text>
            ) : (
              gitProjects.map(({ project, placements }) => (
                <View key={project.projectKey} style={styles.projectPickerGroup}>
                  <Text style={styles.projectPickerGroupLabel}>{project.projectName}</Text>
                  {placements.map((placement) => {
                    const selected =
                      value?.projectKey === project.projectKey &&
                      value.serverId === placement.serverId &&
                      value.projectId === placement.projectId;
                    return (
                      <ProjectPlacementOption
                        key={`${placement.serverId}/${placement.projectId}`}
                        project={project}
                        placement={placement}
                        selected={selected}
                        onSelect={choose}
                        styles={styles}
                      />
                    );
                  })}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function DetailHero({
  pullRequest,
  detail,
  now,
  styles,
}: Pick<ReviewDetailProps, "detail" | "now" | "pullRequest" | "styles">) {
  const statusDanger = pullRequest.reviewState === "changes-requested";
  const statusStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.statusBadge, statusDanger ? styles.statusBadgeDanger : null],
    [statusDanger, styles],
  );
  const statusTextStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.statusBadgeText, statusDanger ? styles.statusBadgeDangerText : null],
    [statusDanger, styles],
  );
  const additionsStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.stat, styles.additions],
    [styles],
  );
  const deletionsStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.stat, styles.deletions],
    [styles],
  );
  const changeSummary = detail
    ? `${detail.changedFiles} ${detail.changedFiles === 1 ? "file" : "files"}`
    : "Loading change summary...";
  const age = relativeAge(pullRequest.updatedAt, now);
  const updatedLabel = age === "now" ? "updated now" : `updated ${age} ago`;
  return (
    <View style={styles.detailHero}>
      <View style={statusStyle}>
        <Text style={statusTextStyle}>{reviewStatusLabel(pullRequest)}</Text>
      </View>
      <Text style={styles.detailTitle}>{pullRequest.title}</Text>
      <Text style={styles.detailByline}>
        @{pullRequest.author} · {updatedLabel}
      </Text>
      <View style={styles.statsRow}>
        {detail ? <Text style={additionsStyle}>+{detail.additions}</Text> : null}
        {detail ? <Text style={deletionsStyle}>−{detail.deletions}</Text> : null}
        <Text style={styles.stat}>{changeSummary}</Text>
        {pullRequest.autoMerge ? <Text style={styles.stat}>Auto-merge on</Text> : null}
      </View>
    </View>
  );
}

function DecisionActions({
  pullRequest,
  busyAction,
  onApprove,
  onMarkUnread,
  toolbar = false,
  styles,
}: Pick<
  ReviewDetailProps,
  "busyAction" | "onApprove" | "onMarkUnread" | "pullRequest" | "styles"
> & { toolbar?: boolean }) {
  const busy = busyAction !== null;
  let unreadLabel = pullRequest.unread ? "Unread" : "Mark unread";
  if (busyAction === "read") unreadLabel = "Marking read...";
  if (busyAction === "unread") unreadLabel = "Marking unread...";
  return (
    <View style={toolbar ? styles.detailToolbarActions : styles.actionRow}>
      <ActionButton
        label={unreadLabel}
        variant="ghost"
        disabled={busy || pullRequest.unread}
        onPress={onMarkUnread}
        styles={styles}
      />
      <ActionButton
        label={busyAction === "approve" ? "Approving..." : "Approve"}
        variant="primary"
        disabled={busy}
        onPress={onApprove}
        styles={styles}
      />
    </View>
  );
}

function ProjectActions({
  pullRequest,
  busyAction,
  projects,
  projectsStatus,
  selectedPlacement,
  canOpenWorkspace,
  onOpenWorkspace,
  onMap,
  styles,
}: Pick<
  ReviewDetailProps,
  | "busyAction"
  | "onMap"
  | "onOpenWorkspace"
  | "projects"
  | "projectsStatus"
  | "canOpenWorkspace"
  | "pullRequest"
  | "selectedPlacement"
  | "styles"
>) {
  const busy = busyAction !== null;
  const mapped = pullRequest.projectMapping !== null;
  const available = selectedPlacement !== null;
  const online = selectedPlacement?.isOnline ?? false;
  let mappingHint = `Choose the Paseo project that contains ${pullRequest.repository}.`;
  if (mapped && !available)
    mappingHint = "The mapped project is no longer available. Choose another project.";
  else if (available && !online)
    mappingHint = `${selectedPlacement.serverName} is offline. You can change the mapping or reconnect that host.`;
  else if (available) {
    mappingHint = "Create an isolated review workspace with the PR branch checked out.";
  }

  return (
    <View style={styles.actionPanel}>
      <View style={styles.mappingHeader}>
        <View style={styles.mappingTitleGroup}>
          <Text style={styles.mappingTitle}>Project</Text>
          <Text style={styles.actionHint}>{mappingHint}</Text>
        </View>
        <ProjectPicker
          projects={projects}
          projectsStatus={projectsStatus}
          value={pullRequest.projectMapping}
          disabled={busyAction === "map"}
          saving={busyAction === "map"}
          onSelect={onMap}
          styles={styles}
        />
      </View>
      {available && canOpenWorkspace ? (
        <View style={styles.actionRow}>
          <ActionButton
            label={busyAction === "worktree" ? "Creating workspace..." : "Review Workspace"}
            variant="primary"
            disabled={busy || !online}
            onPress={onOpenWorkspace}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

function DetailTabs({
  detailTab,
  onSelectTab,
  styles,
}: Pick<ReviewDetailProps, "detailTab" | "onSelectTab" | "styles">) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      <DetailTabButton
        tab="overview"
        selected={detailTab === "overview"}
        onSelect={onSelectTab}
        styles={styles}
      />
      <DetailTabButton
        tab="diff"
        selected={detailTab === "diff"}
        onSelect={onSelectTab}
        styles={styles}
      />
    </View>
  );
}

function DetailBody({
  detail,
  detailLoading,
  detailError,
  detailTab,
  styles,
}: Pick<ReviewDetailProps, "detail" | "detailError" | "detailLoading" | "detailTab" | "styles">) {
  const loadError = errorMessage(detailError);
  if (detailLoading && !detail) {
    return <Text style={styles.bodyEmpty}>Loading pull request...</Text>;
  }
  if (loadError) return <Text style={styles.notice}>{loadError}</Text>;
  if (detailTab === "overview") {
    const body = detail?.body.trim();
    return (
      <View style={styles.overview}>
        <Text style={styles.sectionTitle}>Description</Text>
        <Text selectable style={body ? styles.bodyText : styles.bodyEmpty}>
          {body || "This pull request has no description."}
        </Text>
      </View>
    );
  }
  if (!detail) return null;
  return (
    <View style={styles.overview}>
      <View style={styles.diffHeader}>
        <Text style={styles.sectionTitle}>Changes</Text>
        <Text style={styles.stat}>
          {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
        </Text>
      </View>
      <DiffView detail={detail} styles={styles} />
    </View>
  );
}

export function ReviewDetail(props: ReviewDetailProps) {
  const {
    compact,
    pullRequest,
    detail,
    detailTab,
    now,
    busyAction,
    actionError,
    onApprove,
    onBack,
    onMarkUnread,
    onOpenUrl,
    onSelectTab,
    styles,
  } = props;
  return (
    <View style={styles.detailPane}>
      <View style={styles.detailToolbar}>
        {onBack ? (
          <View style={styles.backButton}>
            <ActionButton label="Back" variant="ghost" onPress={onBack} styles={styles} />
          </View>
        ) : null}
        <Text style={styles.detailBreadcrumb} numberOfLines={1}>
          {pullRequest.repository} · #{pullRequest.number}
        </Text>
        <ActionButton label="Open on GitHub" variant="ghost" onPress={onOpenUrl} styles={styles} />
        {!compact ? (
          <DecisionActions
            pullRequest={pullRequest}
            busyAction={busyAction}
            onApprove={onApprove}
            onMarkUnread={onMarkUnread}
            toolbar
            styles={styles}
          />
        ) : null}
      </View>
      <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent}>
        <DetailHero pullRequest={pullRequest} detail={detail} now={now} styles={styles} />
        {compact ? (
          <DecisionActions
            pullRequest={pullRequest}
            busyAction={busyAction}
            onApprove={onApprove}
            onMarkUnread={onMarkUnread}
            styles={styles}
          />
        ) : null}
        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
        <ProjectActions {...props} />
        <DetailTabs detailTab={detailTab} onSelectTab={onSelectTab} styles={styles} />
        <DetailBody {...props} />
      </ScrollView>
    </View>
  );
}
