import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

type Theme = PluginSurfaceProps["theme"];

function parseHex(color: string): [number, number, number] | null {
  const value = color.replace("#", "");
  if (value.length !== 3 && value.length !== 6) return null;
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : value;
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(expanded.slice(offset, offset + 2), 16),
  );
  return channels.every(Number.isFinite) ? (channels as [number, number, number]) : null;
}

/** Build the missing surface ramp from the compact plugin theme contract. */
function mix(base: string, tint: string, amount: number): string {
  const baseChannels = parseHex(base);
  const tintChannels = parseHex(tint);
  if (!baseChannels || !tintChannels) return base;
  const channels = baseChannels.map((channel, index) =>
    Math.round(channel + ((tintChannels[index] ?? channel) - channel) * amount),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function createStyles(theme: Theme, compact: boolean) {
  const { colors } = theme;
  const surfaceRaised = mix(colors.surface0, colors.foreground, 0.045);
  const surfaceHover = mix(colors.surface0, colors.foreground, 0.075);
  const surfacePressed = mix(colors.surface0, colors.foreground, 0.11);
  const surfaceSelected = mix(colors.surface0, colors.accent, 0.13);
  const border = mix(colors.surface0, colors.foreground, 0.14);
  const borderStrong = mix(colors.surface0, colors.foreground, 0.24);
  const accentSubtle = mix(colors.surface0, colors.accent, 0.11);
  const dangerSubtle = mix(colors.surface0, colors.statusDanger, 0.11);
  const gutter = compact ? 14 : 20;

  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    split: { flex: 1, flexDirection: "row" as const },
    queuePane: {
      width: "42%" as const,
      minWidth: 360,
      maxWidth: 520,
      borderRightWidth: 1,
      borderRightColor: border,
      backgroundColor: colors.surface0,
    },
    compactPane: { flex: 1, backgroundColor: colors.surface0 },

    queueHeader: {
      paddingHorizontal: gutter,
      paddingTop: compact ? 12 : 16,
      paddingBottom: 12,
      gap: 10,
      borderBottomWidth: 1,
      borderBottomColor: border,
    },
    queueTitleRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
    },
    queueTitleGroup: { flex: 1, gap: 2 },
    queueTitle: {
      color: colors.foreground,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: "500" as const,
    },
    queueCount: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    headerActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    filterChips: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
    filterChip: {
      minHeight: 28,
      justifyContent: "center" as const,
      paddingHorizontal: 11,
      borderRadius: 999,
      backgroundColor: "transparent",
    },
    filterChipSelected: { backgroundColor: surfacePressed },
    filterChipHovered: { backgroundColor: surfaceHover },
    filterChipPressed: { backgroundColor: surfacePressed },
    filterChipText: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    filterChipTextSelected: { color: colors.foreground, fontWeight: "500" as const },

    statusBlock: { gap: 6 },
    statusRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    status: { flex: 1, color: colors.foregroundMuted, fontSize: 11.5, lineHeight: 16 },
    track: {
      height: 2,
      borderRadius: 2,
      backgroundColor: surfacePressed,
      overflow: "hidden" as const,
    },
    trackFill: { height: "100%" as const, backgroundColor: colors.accent },
    log: {
      maxHeight: 128,
      padding: 9,
      gap: 3,
      borderRadius: 8,
      backgroundColor: surfaceRaised,
    },
    logLine: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
    notice: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: dangerSubtle,
      color: colors.statusDanger,
      fontSize: 12,
      lineHeight: 17,
    },

    queueScroll: { flex: 1 },
    queueContent: { paddingHorizontal: 8, paddingVertical: 8, gap: 2 },
    sectionLabel: {
      color: colors.foregroundMuted,
      fontSize: 11.5,
      lineHeight: 16,
      fontWeight: "500" as const,
      paddingHorizontal: 8,
      paddingTop: 4,
      paddingBottom: 6,
    },
    queueEmpty: {
      alignItems: "center" as const,
      paddingHorizontal: 24,
      paddingVertical: 52,
      gap: 6,
    },
    queueEmptyTitle: { color: colors.foreground, fontSize: 14, fontWeight: "500" as const },
    queueEmptyText: {
      color: colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center" as const,
    },

    reviewRow: {
      minHeight: 70,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 10,
      paddingHorizontal: 9,
      paddingVertical: 10,
      borderRadius: 8,
    },
    reviewRowHovered: { backgroundColor: surfaceRaised },
    reviewRowPressed: { backgroundColor: surfacePressed },
    reviewRowSelected: { backgroundColor: surfaceSelected },
    reviewMark: { width: 15, height: 20, marginTop: 1, position: "relative" as const },
    reviewMarkLine: {
      position: "absolute" as const,
      left: 3,
      top: 4,
      width: 1,
      height: 12,
      backgroundColor: colors.accent,
    },
    reviewMarkBranch: {
      position: "absolute" as const,
      left: 4,
      top: 9,
      width: 7,
      height: 1,
      backgroundColor: colors.accent,
      transform: [{ rotate: "-38deg" }],
    },
    reviewMarkDotTop: {
      position: "absolute" as const,
      left: 0,
      top: 0,
      width: 7,
      height: 7,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.accent,
      backgroundColor: colors.surface0,
    },
    reviewMarkDotBottom: {
      position: "absolute" as const,
      left: 0,
      bottom: 0,
      width: 7,
      height: 7,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.accent,
      backgroundColor: colors.surface0,
    },
    reviewMarkDotBranch: {
      position: "absolute" as const,
      right: 0,
      top: 5,
      width: 7,
      height: 7,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.accent,
      backgroundColor: colors.surface0,
    },
    reviewRowBody: { flex: 1, minWidth: 0, gap: 4 },
    reviewRowTop: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    reviewTitle: {
      flex: 1,
      color: colors.foreground,
      fontSize: 13.5,
      lineHeight: 19,
      fontWeight: "500" as const,
    },
    reviewTitleUnread: { fontWeight: "600" as const },
    reviewUnreadDot: {
      width: 6,
      height: 6,
      marginTop: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
    },
    reviewAge: { color: colors.foregroundMuted, fontSize: 11.5, lineHeight: 18 },
    reviewMetaRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    reviewMeta: { color: colors.foregroundMuted, fontSize: 11.5, lineHeight: 16 },
    reviewState: { color: colors.accent, fontSize: 11, lineHeight: 16 },
    reviewStateDanger: { color: colors.statusDanger },

    detailPane: { flex: 1, minWidth: 0, backgroundColor: colors.surface0 },
    detailToolbar: {
      minHeight: 44,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: gutter,
      borderBottomWidth: 1,
      borderBottomColor: border,
    },
    detailToolbarActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
    },
    backButton: { marginLeft: -8 },
    detailBreadcrumb: {
      flex: 1,
      color: colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 18,
    },
    detailScroll: { flex: 1 },
    detailContent: {
      width: "100%" as const,
      maxWidth: 900,
      alignSelf: "center" as const,
      paddingHorizontal: compact ? 16 : 28,
      paddingTop: compact ? 18 : 28,
      paddingBottom: compact ? 40 : 64,
      gap: 22,
    },
    detailHero: { gap: 8 },
    detailTitle: {
      color: colors.foreground,
      fontSize: compact ? 20 : 22,
      lineHeight: compact ? 27 : 30,
      fontWeight: "600" as const,
      letterSpacing: -0.25,
    },
    detailByline: { color: colors.foregroundMuted, fontSize: 12.5, lineHeight: 18 },
    statsRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      flexWrap: "wrap" as const,
    },
    stat: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    additions: { color: colors.accent },
    deletions: { color: colors.statusDanger },
    statusBadge: {
      alignSelf: "flex-start" as const,
      minHeight: 24,
      justifyContent: "center" as const,
      paddingHorizontal: 8,
      borderRadius: 999,
      backgroundColor: accentSubtle,
    },
    statusBadgeDanger: { backgroundColor: dangerSubtle },
    statusBadgeText: { color: colors.accent, fontSize: 11.5, fontWeight: "500" as const },
    statusBadgeDangerText: { color: colors.statusDanger },

    actionPanel: {
      padding: 12,
      gap: 10,
      borderRadius: 10,
      backgroundColor: surfaceRaised,
    },
    actionRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 7,
      flexWrap: "wrap" as const,
    },
    actionHint: { color: colors.foregroundMuted, fontSize: 11.5, lineHeight: 17 },
    actionError: {
      color: colors.statusDanger,
      fontSize: 12,
      lineHeight: 18,
      paddingTop: 2,
    },
    mappingHeader: { gap: 9 },
    mappingTitleGroup: { gap: 3 },
    mappingTitle: {
      color: colors.foreground,
      fontSize: 12.5,
      lineHeight: 18,
      fontWeight: "500" as const,
    },
    projectPicker: { width: "100%" as const, gap: 5 },
    projectPickerTrigger: {
      minHeight: 48,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderWidth: 1,
      borderColor: borderStrong,
      borderRadius: 8,
      backgroundColor: colors.surface0,
    },
    projectPickerTriggerHovered: { borderColor: mix(borderStrong, colors.foreground, 0.28) },
    projectPickerTriggerPressed: { backgroundColor: surfaceHover },
    projectPickerLabelGroup: { flex: 1, minWidth: 0, gap: 1 },
    projectPickerLabel: {
      color: colors.foreground,
      fontSize: 12.5,
      lineHeight: 17,
      fontWeight: "500" as const,
    },
    projectPickerPlaceholder: {
      color: colors.foregroundMuted,
      fontSize: 12.5,
      lineHeight: 17,
    },
    projectPickerDetail: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
    projectPickerChevron: { color: colors.foregroundMuted, fontSize: 14, lineHeight: 18 },
    projectPickerMenu: {
      maxHeight: compact ? 300 : 260,
      borderWidth: 1,
      borderColor: borderStrong,
      borderRadius: 9,
      overflow: "hidden" as const,
      backgroundColor: colors.surface0,
    },
    projectPickerScroll: { maxHeight: compact ? 300 : 260 },
    projectPickerGroup: {
      paddingHorizontal: 5,
      paddingTop: 6,
      paddingBottom: 4,
      gap: 1,
    },
    projectPickerGroupLabel: {
      paddingHorizontal: 7,
      paddingVertical: 4,
      color: colors.foregroundMuted,
      fontSize: 10.5,
      lineHeight: 14,
      fontWeight: "500" as const,
    },
    projectPickerOption: {
      minHeight: compact ? 48 : 42,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingHorizontal: 7,
      paddingVertical: 5,
      borderRadius: 7,
    },
    projectPickerOptionHovered: { backgroundColor: surfaceHover },
    projectPickerOptionPressed: { backgroundColor: surfacePressed },
    projectPickerOptionBody: { flex: 1, minWidth: 0, gap: 1 },
    projectPickerOptionTitleRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 7,
    },
    projectPickerOptionTitle: {
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 17,
      fontWeight: "500" as const,
    },
    projectPickerOffline: { color: colors.foregroundMuted, fontSize: 10.5, lineHeight: 15 },
    projectPickerOptionPath: {
      color: colors.foregroundMuted,
      fontSize: 10.5,
      lineHeight: 15,
    },
    projectPickerCheck: {
      width: 18,
      color: colors.accent,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center" as const,
    },
    projectPickerEmpty: {
      paddingHorizontal: 12,
      paddingVertical: 16,
      color: colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 17,
    },

    button: {
      minHeight: 32,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 11,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: borderStrong,
      backgroundColor: "transparent",
    },
    buttonPrimary: { borderColor: colors.accent, backgroundColor: colors.accent },
    buttonGhost: { borderColor: "transparent" },
    buttonHovered: { backgroundColor: surfaceHover },
    buttonPrimaryHovered: { backgroundColor: mix(colors.accent, colors.foreground, 0.12) },
    buttonPressed: { backgroundColor: surfacePressed },
    buttonDisabled: { opacity: 0.42 },
    buttonText: {
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: "500" as const,
    },
    buttonPrimaryText: { color: colors.accentForeground },
    buttonMutedText: { color: colors.foregroundMuted },
    buttonDangerText: { color: colors.statusDanger },

    tabs: {
      flexDirection: "row" as const,
      alignSelf: "flex-start" as const,
      gap: 2,
      padding: 3,
      borderRadius: 9,
      backgroundColor: surfaceRaised,
    },
    tab: {
      minHeight: 28,
      justifyContent: "center" as const,
      paddingHorizontal: 11,
      borderRadius: 7,
    },
    tabSelected: { backgroundColor: surfacePressed },
    tabHovered: { backgroundColor: surfaceHover },
    tabText: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    tabTextSelected: { color: colors.foreground, fontWeight: "500" as const },

    overview: { gap: 10 },
    sectionTitle: {
      color: colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 17,
      fontWeight: "500" as const,
    },
    bodyText: { color: colors.foreground, fontSize: 15, lineHeight: 23 },
    bodyEmpty: { color: colors.foregroundMuted, fontSize: 14, lineHeight: 21 },
    diffHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 10,
    },
    diffFiles: { gap: 8 },
    diffFile: {
      borderWidth: 1,
      borderColor: border,
      borderRadius: 10,
      overflow: "hidden" as const,
      backgroundColor: surfaceRaised,
    },
    diffFileHeader: {
      minHeight: 38,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 10,
      backgroundColor: surfaceRaised,
    },
    diffFileHeaderHovered: { backgroundColor: surfaceHover },
    diffFileHeaderPressed: { backgroundColor: surfacePressed },
    diffFileChevron: {
      width: 14,
      color: colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center" as const,
    },
    diffFileName: {
      flex: 1,
      minWidth: 0,
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 17,
      fontWeight: "500" as const,
      fontFamily: "Menlo, Consolas, monospace",
    },
    diffFileStats: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    diffFileAdditions: {
      color: colors.accent,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: "500" as const,
    },
    diffFileDeletions: {
      color: colors.statusDanger,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: "500" as const,
    },
    diffCode: { minWidth: "100%" as const, paddingVertical: 8 },
    diffLine: {
      minWidth: "100%" as const,
      paddingHorizontal: 12,
      color: colors.foregroundMuted,
      fontSize: 11.5,
      lineHeight: 17,
      fontFamily: "Menlo, Consolas, monospace",
    },
    diffLineAdd: { color: colors.accent, backgroundColor: accentSubtle },
    diffLineRemove: { color: colors.statusDanger, backgroundColor: dangerSubtle },
    diffLineMeta: {
      color: colors.foreground,
      backgroundColor: surfacePressed,
      fontWeight: "500" as const,
    },
    diffNotice: {
      color: colors.foregroundMuted,
      fontSize: 11.5,
      lineHeight: 17,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderWidth: 1,
      borderColor: border,
      borderRadius: 8,
      backgroundColor: surfaceRaised,
    },

    emptyDetail: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: 32,
      gap: 10,
    },
    emptyGraphic: {
      width: 64,
      height: 64,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: 18,
      backgroundColor: surfaceRaised,
      marginBottom: 4,
    },
    emptyGraphicText: { color: colors.foregroundMuted, fontSize: 30, fontWeight: "300" as const },
    emptyDetailTitle: {
      color: colors.foreground,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: "500" as const,
    },
    emptyDetailText: {
      maxWidth: 310,
      color: colors.foregroundMuted,
      fontSize: 12.5,
      lineHeight: 18,
      textAlign: "center" as const,
    },
  };
}

export type Styles = ReturnType<typeof createStyles>;
