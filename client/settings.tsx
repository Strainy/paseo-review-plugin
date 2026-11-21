import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import {
  SETTINGS_STATUSES,
  readSettings,
  writeSettings,
  type Settings,
  type SettingsSnapshot,
  type SettingsStatus,
} from "../shared/settings";
import { SurfacePressable } from "./card";
import {
  addEntries,
  formatNumber,
  parseEntries,
  parseNumber,
  sameSettings,
  setLastUpdated,
  toggleStatus,
  validationErrors,
  withPendingEntries,
  writeList,
  type FilterScope,
  type ListField,
  type NumberField,
  type PendingEntries,
} from "./settings-draft";
import { createStyles, type Styles } from "./theme";

export const SETTINGS_SCREEN_ID = "reviews";
export const SETTINGS_QUERY_KEY = ["settings"] as const;

type ReadySnapshot = Extract<SettingsSnapshot, { status: "ready" }>;
type InputErrors = Partial<Record<NumberField, string>>;
/** Messages keyed by dotted settings path, such as `include.lastUpdated`. */
type FieldErrors = Record<string, string | undefined>;

const STATUS_LABELS: Record<SettingsStatus, string> = {
  open: "Open",
  draft: "Draft",
  ready: "Ready",
  "auto-merge": "Auto-merge",
  approved: "Approved",
  "bot-approved": "Bot approved",
  "changes-requested": "Changes requested",
  unreviewed: "Unreviewed",
  merged: "Merged",
  closed: "Closed",
};

interface ListCopy {
  label: string;
  hint: string;
  singular: string;
  plural: string;
  placeholder: string;
}

const LIST_COPY: Record<ListField, ListCopy> = {
  "include.repositories": {
    label: "Repositories",
    hint: "Leave empty for every repository. This is the cheapest filter: it applies before any PR is fetched.",
    singular: "repository",
    plural: "repositories",
    placeholder: "owner/repo",
  },
  "include.authors": {
    label: "Authors",
    hint: "PRs opened by these logins. Authors and teams are additive: either one matching includes the PR.",
    singular: "author",
    plural: "authors",
    placeholder: "login",
  },
  "include.teams": {
    label: "Teams",
    hint: "PRs that request review from these teams. A bare slug inherits the PR's organization.",
    singular: "team",
    plural: "teams",
    placeholder: "team or org/team",
  },
  "exclude.repositories": {
    label: "Repositories",
    hint: "Never show PRs from these repositories.",
    singular: "repository",
    plural: "repositories",
    placeholder: "owner/repo",
  },
  "exclude.authors": {
    label: "Authors",
    hint: "Hide PRs opened by these logins. A bot slug such as renovate also matches renovate[bot].",
    singular: "author",
    plural: "authors",
    placeholder: "login",
  },
  "exclude.teams": {
    label: "Teams",
    hint: "Hide PRs that request review from these teams.",
    singular: "team",
    plural: "teams",
    placeholder: "team or org/team",
  },
  botReviewers: {
    label: "Bot reviewers",
    hint: "Approvals from these logins show as Bot approved. Accounts GitHub marks as bots, such as renovate[bot], need no entry.",
    singular: "bot reviewer",
    plural: "bot reviewers",
    placeholder: "login",
  },
};

const FILTER_COPY: Record<
  FilterScope,
  { title: string; info: string; status: string; lastUpdated: string }
> = {
  include: {
    title: "Include",
    info: "A PR must match the repository, people, status, and age filters you set here. Empty filters match everything.",
    status: "Show PRs in any selected state. With none selected, open PRs are shown, including drafts.",
    lastUpdated:
      "Only PRs updated within this age, such as 48h, 30d, or 2w. It also bounds the notification sweep, so a short age keeps refreshes fast.",
  },
  exclude: {
    title: "Exclude",
    info: "Anything matching an exclusion is hidden, even when it matches the include filters.",
    status: "Hide PRs in any selected state.",
    lastUpdated: "Hide PRs not updated within this age. When both are set, the shorter age wins.",
  },
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paseo's settings frame owns the header and scrolling; this renders sections only. */
export function ReviewSettings({ theme, layout }: PluginSurfaceProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const read = useRpc(readSettings);
  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => read({}),
    // The editor holds a draft against the revision it loaded, so only an
    // explicit save or reload replaces it. Each visit reads the file afresh.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const { refetch } = settings;
  const reload = useCallback(() => void refetch(), [refetch]);

  if (settings.isPending) {
    return (
      <SettingsSection title="Settings file">
        <SettingsCard>
          <SettingsRow label="Loading settings..." />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.isError) {
    return (
      <SettingsSection title="Settings file">
        <SettingsCard>
          <SettingsAction
            label="Settings could not be loaded"
            error={messageFrom(settings.error)}
            actionLabel="Retry"
            onPress={reload}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.data.status === "invalid") {
    return <InvalidSettings snapshot={settings.data} onReload={reload} />;
  }
  return (
    <SettingsEditor
      key={settings.data.revision}
      snapshot={settings.data}
      styles={styles}
      onReload={reload}
    />
  );
}

function useSaveSettings(path: string) {
  const write = useRpc(writeSettings);
  const queryClient = useQueryClient();
  return useCallback(
    async (revision: string, values: unknown) => {
      const result = await write({ revision, values });
      if (result.status === "saved") {
        const saved: SettingsSnapshot = {
          status: "ready",
          path,
          revision: result.revision,
          values: result.values,
        };
        queryClient.setQueryData(SETTINGS_QUERY_KEY, saved);
        // Filters and the poll interval apply on the next list request.
        void queryClient.invalidateQueries({ queryKey: ["reviews"] });
      }
      return result;
    },
    [path, queryClient, write],
  );
}

function InvalidSettings({
  snapshot,
  onReload,
}: {
  snapshot: Extract<SettingsSnapshot, { status: "invalid" }>;
  onReload: () => void;
}) {
  const save = useSaveSettings(snapshot.path);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replace = useCallback(async () => {
    setReplacing(true);
    setError(null);
    try {
      const result = await save(snapshot.revision, {});
      if (result.status !== "saved") setError(result.error);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setReplacing(false);
    }
  }, [save, snapshot.revision]);
  return (
    <SettingsSection title="Settings file">
      <SettingsCard>
        <SettingsRow
          label="The settings file is not valid"
          hint={snapshot.path}
          error={snapshot.error}
        />
        <SettingsAction
          label="Fixed the file by hand?"
          actionLabel="Reload"
          disabled={replacing}
          onPress={onReload}
        />
        <SettingsAction
          label="Start over with default settings"
          hint="Overwrites the file above."
          error={error}
          actionLabel={replacing ? "Replacing..." : "Replace"}
          disabled={replacing}
          onPress={replace}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function SettingsEditor({
  snapshot,
  styles,
  onReload,
}: {
  snapshot: ReadySnapshot;
  styles: Styles;
  onReload: () => void;
}) {
  const save = useSaveSettings(snapshot.path);
  const [draft, setDraft] = useState<Settings>(snapshot.values);
  const [pending, setPending] = useState<PendingEntries>({});
  const [inputErrors, setInputErrors] = useState<InputErrors>({});
  // Inputs own their text once mounted; a new generation reseeds them.
  const [generation, setGeneration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(
    null,
  );

  const candidate = useMemo(() => withPendingEntries(draft, pending), [draft, pending]);
  const errors = useMemo<FieldErrors>(
    () => ({ ...validationErrors(candidate), ...inputErrors }),
    [candidate, inputErrors],
  );
  const valid = Object.values(errors).every((message) => message === undefined);
  const dirty = Object.keys(inputErrors).length > 0 || !sameSettings(candidate, snapshot.values);

  const changeList = useCallback(
    (field: ListField, entries: string[]) => setDraft((values) => writeList(values, field, entries)),
    [],
  );
  const changePending = useCallback(
    (field: ListField, text: string) => setPending((current) => ({ ...current, [field]: text })),
    [],
  );
  const changeStatus = useCallback(
    (scope: FilterScope, status: SettingsStatus) =>
      setDraft((values) => ({
        ...values,
        [scope]: { ...values[scope], status: toggleStatus(values[scope].status, status) },
      })),
    [],
  );
  const changeLastUpdated = useCallback(
    (scope: FilterScope, text: string) => setDraft((values) => setLastUpdated(values, scope, text)),
    [],
  );
  const changeNumber = useCallback((field: NumberField, text: string) => {
    const value = parseNumber(field, text);
    setInputErrors((current) => {
      const { [field]: _previous, ...rest } = current;
      return value === null ? { ...rest, [field]: "Enter a number" } : rest;
    });
    if (value !== null) setDraft((values) => ({ ...values, [field]: value }));
  }, []);
  const changeLookback = useCallback(
    (notificationLookback: string) => setDraft((values) => ({ ...values, notificationLookback })),
    [],
  );
  const changeProvider = useCallback(
    (agentProvider: string) => setDraft((values) => ({ ...values, agentProvider })),
    [],
  );

  const submit = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // On success the cached snapshot gets a new revision, which remounts the
      // editor from the saved document.
      const result = await save(snapshot.revision, candidate);
      if (result.status !== "saved") {
        setSaveError({ message: result.error, conflict: result.status === "conflict" });
      }
    } catch (error) {
      setSaveError({ message: messageFrom(error), conflict: false });
    } finally {
      setSaving(false);
    }
  }, [candidate, save, snapshot.revision]);
  const discard = useCallback(() => {
    setDraft(snapshot.values);
    setPending({});
    setInputErrors({});
    setSaveError(null);
    setGeneration((current) => current + 1);
  }, [snapshot.values]);

  const saveRows = (
    <SaveRows
      dirty={dirty}
      valid={valid}
      saving={saving}
      error={saveError}
      onSave={submit}
      onDiscard={discard}
      onReload={onReload}
    />
  );
  const fieldProps = { disabled: saving, errors, pending, styles };

  return (
    <>
      <SettingsSection
        title="Settings file"
        info="Everything here is stored in this file. You can still edit it by hand; reload this page afterwards."
      >
        <SettingsCard>
          <SettingsRow label="Location" hint={snapshot.path} />
          {saveRows}
        </SettingsCard>
      </SettingsSection>

      <Fragment key={generation}>
        {(["include", "exclude"] as const).map((scope) => (
          <FilterSection
            key={scope}
            scope={scope}
            values={draft}
            onChangeList={changeList}
            onChangePending={changePending}
            onToggleStatus={changeStatus}
            onChangeLastUpdated={changeLastUpdated}
            {...fieldProps}
          />
        ))}

        <SettingsSection
          title="Approvals"
          info="Machine users look like people to GitHub, so their approvals show as Approved unless they are listed here."
        >
          <ListCard
            field="botReviewers"
            entries={draft.botReviewers}
            onChange={changeList}
            onChangePending={changePending}
            {...fieldProps}
          />
        </SettingsSection>

        <SettingsSection
          title="Refresh"
          info="How often the inbox polls GitHub and how much work each poll may do."
        >
          <SettingsCard>
            <NumberInput
              field="refreshIntervalMs"
              label="Refresh interval (seconds)"
              hint="Shared by the inbox and the sidebar badge. At least 30 seconds."
              value={draft.refreshIntervalMs}
              onChange={changeNumber}
              {...fieldProps}
            />
            <SettingsInput
              label="Notification lookback"
              hint="How far back to read notifications when no include age is set, such as 7d. The shorter of the two wins."
              placeholder="7d"
              initialValue={draft.notificationLookback}
              onChangeText={changeLookback}
              error={errors.notificationLookback}
              disabled={saving}
            />
            <NumberInput
              field="maxDetailFetches"
              label="Detail fetches per refresh"
              hint="Caps uncached PR lookups per poll, newest first. The rest wait for later polls."
              value={draft.maxDetailFetches}
              onChange={changeNumber}
              {...fieldProps}
            />
            <NumberInput
              field="detailConcurrency"
              label="Parallel detail fetches"
              hint="Between 1 and 10. Kept low to stay clear of GitHub's secondary rate limits."
              value={draft.detailConcurrency}
              onChange={changeNumber}
              {...fieldProps}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Review workspaces">
          <SettingsCard>
            <SettingsInput
              label="Fallback agent provider"
              hint="Used when the project has no previous agent. A provider such as claude, or provider/model such as codex/gpt-5.5."
              placeholder="claude"
              initialValue={draft.agentProvider}
              onChangeText={changeProvider}
              error={errors.agentProvider}
              disabled={saving}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Cache">
          <SettingsCard>
            <NumberInput
              field="cacheMaxBytes"
              label="Cache size (MB)"
              hint="PR details kept on disk between refreshes. Older entries are dropped past this size."
              value={draft.cacheMaxBytes}
              onChange={changeNumber}
              {...fieldProps}
            />
          </SettingsCard>
        </SettingsSection>
      </Fragment>

      <SettingsSection title="Changes">
        <SettingsCard>{saveRows}</SettingsCard>
      </SettingsSection>
    </>
  );
}

function SaveRows({
  dirty,
  valid,
  saving,
  error,
  onSave,
  onDiscard,
  onReload,
}: {
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  error: { message: string; conflict: boolean } | null;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  let label = "No unsaved changes";
  if (saving) label = "Saving...";
  else if (dirty && !valid) label = "Fix the highlighted fields to save";
  else if (dirty) label = "Unsaved changes";
  return (
    <>
      <SettingsAction
        label={label}
        error={error?.message}
        actionLabel="Save"
        disabled={!dirty || !valid || saving}
        onPress={onSave}
      />
      {error?.conflict ? (
        <SettingsAction
          label="Load the latest settings"
          hint="Your unsaved changes here are discarded."
          actionLabel="Reload"
          disabled={saving}
          onPress={onReload}
        />
      ) : (
        <SettingsAction
          label="Discard unsaved changes"
          actionLabel="Discard"
          disabled={!dirty || saving}
          onPress={onDiscard}
        />
      )}
    </>
  );
}

interface FieldProps {
  disabled: boolean;
  errors: FieldErrors;
  pending: PendingEntries;
  styles: Styles;
}

function FilterSection({
  scope,
  values,
  onChangeList,
  onChangePending,
  onToggleStatus,
  onChangeLastUpdated,
  ...fieldProps
}: FieldProps & {
  scope: FilterScope;
  values: Settings;
  onChangeList: (field: ListField, entries: string[]) => void;
  onChangePending: (field: ListField, text: string) => void;
  onToggleStatus: (scope: FilterScope, status: SettingsStatus) => void;
  onChangeLastUpdated: (scope: FilterScope, text: string) => void;
}) {
  const copy = FILTER_COPY[scope];
  const filters = values[scope];
  const toggle = useCallback(
    (status: SettingsStatus) => onToggleStatus(scope, status),
    [onToggleStatus, scope],
  );
  const changeAge = useCallback(
    (text: string) => onChangeLastUpdated(scope, text),
    [onChangeLastUpdated, scope],
  );
  return (
    <SettingsSection title={copy.title} info={copy.info}>
      {(["repositories", "authors", "teams"] as const).map((list) => (
        <ListCard
          key={list}
          field={`${scope}.${list}`}
          entries={filters[list]}
          onChange={onChangeList}
          onChangePending={onChangePending}
          {...fieldProps}
        />
      ))}
      <SettingsCard>
        <SettingsRow label="Status" hint={copy.status}>
          <View style={fieldProps.styles.optionChips}>
            {SETTINGS_STATUSES.map((status) => (
              <StatusChip
                key={status}
                status={status}
                selected={filters.status.includes(status)}
                disabled={fieldProps.disabled}
                onToggle={toggle}
                styles={fieldProps.styles}
              />
            ))}
          </View>
        </SettingsRow>
        <SettingsInput
          label="Updated within"
          hint={copy.lastUpdated}
          placeholder="No limit"
          initialValue={filters.lastUpdated ?? ""}
          onChangeText={changeAge}
          error={fieldProps.errors[`${scope}.lastUpdated`]}
          disabled={fieldProps.disabled}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function StatusChip({
  status,
  selected,
  disabled,
  onToggle,
  styles,
}: {
  status: SettingsStatus;
  selected: boolean;
  disabled: boolean;
  onToggle: (status: SettingsStatus) => void;
  styles: Styles;
}) {
  const toggle = useCallback(() => onToggle(status), [onToggle, status]);
  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.optionChip, selected ? styles.optionChipSelected : null],
    [selected, styles],
  );
  const textStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.optionChipText, selected ? styles.optionChipTextSelected : null],
    [selected, styles],
  );
  const accessibilityState = useMemo(() => ({ selected, disabled }), [disabled, selected]);
  return (
    <SurfacePressable
      accessibilityLabel={STATUS_LABELS[status]}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={toggle}
      style={containerStyle}
      hoveredStyle={styles.filterChipHovered}
      pressedStyle={styles.filterChipPressed}
    >
      <Text style={textStyle}>{STATUS_LABELS[status]}</Text>
    </SurfacePressable>
  );
}

function ListCard({
  field,
  entries,
  onChange,
  onChangePending,
  disabled,
  pending,
}: FieldProps & {
  field: ListField;
  entries: string[];
  onChange: (field: ListField, entries: string[]) => void;
  onChangePending: (field: ListField, text: string) => void;
}) {
  const copy = LIST_COPY[field];
  const input = useRef<SettingsInputHandle>(null);
  const additions = useMemo(() => parseEntries(pending[field] ?? ""), [field, pending]);
  const changeText = useCallback(
    (text: string) => onChangePending(field, text),
    [field, onChangePending],
  );
  const add = useCallback(() => {
    onChange(field, addEntries(entries, additions));
    onChangePending(field, "");
    input.current?.replaceText("");
  }, [additions, entries, field, onChange, onChangePending]);
  const remove = useCallback(
    (entry: string) => onChange(field, entries.filter((candidate) => candidate !== entry)),
    [entries, field, onChange],
  );

  let summary = `${entries.length} ${entries.length === 1 ? copy.singular : copy.plural}`;
  if (additions.length > 0) summary = `Add ${additions.join(", ")}`;
  else if (entries.length === 0) summary = `No ${copy.plural}`;
  return (
    <SettingsCard>
      <SettingsInput
        ref={input}
        label={copy.label}
        hint={`${copy.hint} Separate several with commas.`}
        placeholder={copy.placeholder}
        initialValue={pending[field] ?? ""}
        onChangeText={changeText}
        disabled={disabled}
      />
      <SettingsAction
        label={summary}
        actionLabel="Add"
        disabled={disabled || additions.length === 0}
        onPress={add}
      />
      {entries.map((entry) => (
        <ListEntry key={entry} entry={entry} disabled={disabled} onRemove={remove} />
      ))}
    </SettingsCard>
  );
}

function ListEntry({
  entry,
  disabled,
  onRemove,
}: {
  entry: string;
  disabled: boolean;
  onRemove: (entry: string) => void;
}) {
  const remove = useCallback(() => onRemove(entry), [entry, onRemove]);
  return (
    <SettingsAction label={entry} actionLabel="Remove" disabled={disabled} onPress={remove} />
  );
}

function NumberInput({
  field,
  label,
  hint,
  value,
  onChange,
  disabled,
  errors,
}: FieldProps & {
  field: NumberField;
  label: string;
  hint: string;
  value: number;
  onChange: (field: NumberField, text: string) => void;
}) {
  const change = useCallback((text: string) => onChange(field, text), [field, onChange]);
  // Seeded once; the unit conversion only runs on text the user actually changed.
  const [initialValue] = useState(() => formatNumber(field, value));
  return (
    <SettingsInput
      label={label}
      hint={hint}
      initialValue={initialValue}
      onChangeText={change}
      error={errors[field]}
      disabled={disabled}
    />
  );
}
