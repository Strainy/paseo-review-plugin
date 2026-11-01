# paseo-review

A cross-repository GitHub review-request inbox for [Paseo](https://paseo.sh), and a one-click path from "this PR needs my review" to a workspace with the branch checked out and an agent ready to answer questions about it.

It is a port of [`gh-review-tui`](https://github.com/Strainy/gh-review-tui) into Paseo's plugin system. The discovery half — polling GitHub notifications for `review_requested` threads and filtering them — is reimplemented here. The reading half is not: once you are in the review workspace, Paseo's own pull-request panel already gives you the diff, timeline, checks, and merge controls.

## What it does

- Polls `GET /notifications?all=true`, keeps `review_requested` pull-request threads, and applies your include/exclude filters.
- Badges the sidebar row with the unread PR count.
- Maps each GitHub repository to an existing Paseo project on any connected host.
- Creates an isolated worktree with the PR checked out, starts an agent using that project's most recent model, effort, and permission mode, and navigates you there.
- Approves a PR without leaving the inbox.

Discovery is equivalent to the GitHub inbox filter `reason:review-requested is:issue-or-pull-request`, narrowed to pull requests. The REST endpoint exposes `reason` and subject type as response fields rather than query parameters, so those two predicates are applied locally. It does not use the GraphQL API.

## Requirements

- A Paseo app and daemon built from upstream commit `3a9304607c` ([custom sidebar items, #5685](https://github.com/getpaseo/paseo/pull/5685)) or later. The published `0.10.2` SDK predates this API. The manifest requires `>=0.10.0`, the version currently declared by upstream source; the client checks for custom sidebar support and reports update guidance on older builds.
- [GitHub CLI](https://cli.github.com/) available as `gh` on the **daemon** machine, with an authenticated session (`gh auth status`).

The plugin shells out to `gh` from the daemon subprocess and never handles a token itself.

## Install

Plugins are trusted, unsandboxed code. The backend half runs on your daemon machine with access to its files, processes, and credentials; the client half runs inside the Paseo app. Install this only if you are happy with that.

```sh
git clone <this repository> ~/code/paseo-review-plugin
cd ~/code/paseo-review-plugin
npm install
npm run typecheck
npm run lint
npm test

paseo plugin install ~/code/paseo-review-plugin --id paseo-review
paseo plugin ls
```

Plugins are off daemon-wide until you turn them on. Check the current value before changing it:

```sh
paseo config get   # look for pluginsEnabled
```

If `pluginsEnabled` is not `true`, set it in `$PASEO_HOME/config.json` and run `paseo reload`. That switch enables _every_ configured plugin, not just this one.

After editing plugin source, run `npm run typecheck` and `npm run lint`, then `paseo plugin reload paseo-review`. A failed reload stays failed — Paseo does not restore the previous bundle.

```sh
paseo plugin logs paseo-review    # daemon-side output
paseo plugin disable paseo-review
paseo plugin remove paseo-review  # deletes config only, never the source
```

## Configure

Settings live at `$PASEO_HOME/plugin-state/paseo-review/settings.json` (`~/.paseo/...` when `PASEO_HOME` is unset). Without a file, the inbox shows every open PR you have been asked to review, including drafts.

```json
{
  "include": {
    "repositories": ["acme/api", "acme/web"],
    "authors": ["Strainy"],
    "teams": ["platform"],
    "status": ["ready"],
    "lastUpdated": "30d"
  },
  "exclude": {
    "authors": ["acme-renovate", "acme-bot"],
    "status": ["auto-merge", "approved"]
  },
  "agentProvider": "claude",
  "notificationLookback": "7d",
  "maxDetailFetches": 200,
  "detailConcurrency": 4,
  "refreshIntervalMs": 120000,
  "cacheMaxBytes": 52428800
}
```

Copy [`settings.example.json`](settings.example.json) to get started. This plugin does not provide a settings UI.

`agentProvider` is the fallback used when the selected project has no previous agents. It accepts either a provider such as `claude` or an explicit provider/model such as `codex/gpt-5.5`. A provider-only value resolves to that provider's default model on the selected project host.

**Configure `include.repositories` and `include.lastUpdated` before anything else.** They are what make a refresh cheap, and they are the difference between a usable inbox and one that looks broken:

| Setting                | Why it matters                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `include.lastUpdated`  | Sent to GitHub as `since`, bounding the notifications sweep. On a busy account, dropping from unbounded to `1d` took one refresh from 74s and 25 MB to under 4s and 1 MB.      |
| `include.repositories` | Applied to notification threads _before_ any PR detail request, so it decides how many detail fetches happen at all. Unfiltered, the same account produced 1843 candidate PRs. |
| `notificationLookback` | Backstop `since` when no `lastUpdated` filter is set, so a fresh install never sweeps your whole notification history. The shorter of the two wins.                            |
| `maxDetailFetches`     | Ceiling on stale or missing PR detail refreshes per poll, newest first. Cached candidates do not count, and deferred candidates are picked up by later polls.                  |
| `detailConcurrency`    | Detail fetches in flight at once. Small on purpose — the goal is hiding round-trip latency, not pushing GitHub toward a secondary rate limit.                                  |

Each cache miss costs two requests (the PR and its reviews), so cost scales with _matching_ PRs, not with repository count. Subsequent refreshes are mostly cache hits.

### Filter semantics

Within `include`, **authors and teams are additive**: a PR matches if its author is listed _or_ one of the listed teams was asked to review. Repositories narrow the notification threads before any PR detail request is made, so they are the cheapest filter. If both authors and teams are empty, every discovered PR in the included repositories is considered.

`exclude` accepts the same keys, and **an exclusion always beats an inclusion**. A bot slug such as `acme-renovate` matches GitHub's `acme-renovate[bot]`. A bare team slug inherits the organization from the PR's own repository; `org/team-slug` is also accepted.

`status` values are ORed. Accepted: `open`, `draft`, `ready`, `auto-merge`, `approved`, `changes-requested`, `unreviewed`, `merged`, `closed`.

- `ready` means open and not a draft, regardless of review state.
- `auto-merge` means GitHub's `auto_merge` field is set.
- `approved` and `changes-requested` are materialized from each reviewer's latest submitted decision, with changes-requested taking precedence. Comment-only and dismissed reviews carry no decision, so a PR without one is `unreviewed`.
- Submitted approvals remain visible after a new push. Your own approval clears the PR only while it applies to the current head, so a new push returns it to the queue without erasing the approval state.
- With no `status` configured, the inbox shows all open PRs including drafts, and omits merged and closed ones.
- `review-required` is unsupported: branch-protection requirements are not exposed by these responses.

**A PR you approved at its current head is omitted**, whatever the filters say. A new head makes it reviewable again while preserving the approval state. Your login is resolved once from the local `gh` session.

`lastUpdated` is a maximum age accepting `30d`, `2w`, or `48h`. In `include` only PRs updated within that age are shown; in `exclude` PRs older than it are dropped. If both specify one, the shorter wins. The cutoff is sent to the notifications endpoint as `since` and then enforced exactly against each PR's `updated_at`.

### Mapping repositories to projects

Creating a review workspace needs a Paseo project, while a GitHub notification only tells the plugin `owner/repo`. The first time you select a PR from an unmapped repository, choose an existing Git project from the detail pane. The picker groups every known placement by project and includes projects from other Paseo hosts. The selected project and host are saved to `$PASEO_HOME/plugin-state/paseo-review/repositories.json` and reused from then on.

Until a repository is mapped, the PR keeps its **Approve**, **Mark unread**, and GitHub actions, but cannot start a review workspace. An offline host remains visible in the picker, while workspace creation stays disabled until it reconnects.

## Use it

Open **Reviews** in the sidebar, or **⌘K → Open review inbox**.

| Action                  | What happens                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Unread**              | Shows unread PRs. This is selected when the inbox opens.                                                           |
| **All**                 | Shows every PR still awaiting your review, including ones you have opened.                                         |
| Select a review         | Opens its overview and marks the PR as read.                                                                       |
| **Open on GitHub**      | Opens the PR in your OS browser, not inside Paseo.                                                                 |
| **Review Workspace**    | Creates an isolated PR worktree and starts an agent with the project's most recently used model, effort, and mode. |
| **Overview** / **Diff** | Switches between the PR description and a coloured diff grouped into collapsible file sections.                    |
| **Approve**             | Submits an approving review, then drops the PR from the queue.                                                     |
| **Mark unread**         | Returns an opened PR to the unread queue.                                                                          |
| Row **⋯** menu          | Marks a PR unread without opening it. The action is disabled for unread PRs.                                       |
| **Mark all as Read**    | Clears the unread queue, including the currently selected review. PRs remain available in All.                    |
| **Refresh**             | Polls immediately instead of waiting for the interval.                                                             |
| **Activity**            | Shows the step-by-step record of the last refresh.                                                                 |

Read state lives in `$PASEO_HOME/plugin-state/paseo-review/read.json` and survives restarts. Once opened, a PR stays read across commits, reviews, and comments until you choose **Mark unread**. Existing timestamp-based `read.json` values and `hidden.json` entries remain valid read markers.

The selected PR's action panel always shows its project mapping, so you can move a repository between projects or host placements at any time. The workspace actions appear once the mapped project is available.

Selecting a review fetches its description and unified diff on demand and caches them against the PR's head SHA, so a new push re-fetches and everything else is free. Large diffs are truncated with a note rather than silently cut.

While a refresh runs, the status line names the phase it is in rather than a bare spinner: `Polling notifications`, `Filtering — 42 threads received`, `Identifying reviewer — Active account @you`, and then `Loading PR details 3/17 — acme/api#42` with a progress bar. Cache hits, PRs skipped after a rate limit, and pending retries (`GitHub is throttling — retrying in 4s (attempt 2 of 5)`) all show there too. When idle it reads `7 awaiting review · 3m ago`.

Plugin RPC is request/response and Paseo has no daemon-to-app push channel, so the surface polls a `reviews.progress` RPC every 400ms while its own list request is in flight, and stops the moment it lands. The server also keeps a bounded log of the steps it took, which is what **Activity** shows — most of a fast refresh happens between two progress polls, so without it the intermediate phases would flicker past unseen.

The detail pane is for triage — enough to decide whether a PR needs your attention now. Once you are in the review workspace, Paseo's own pull-request panel has the full diff, timeline, and checks.

## How it behaves

**Caching.** On open, the inbox paints immediately from the daemon's on-disk cache and labels itself `showing cached`, then the completed poll replaces it with the authoritative list. That read touches nothing but disk — not even `gh` — so an open tab is never blank while a refresh runs, and a `paseo plugin reload` (which clears the plugin's client-side query state) does not empty it either.

PR details are stored as newline-delimited JSON at `$PASEO_HOME/plugin-state/paseo-review/pull-requests.jsonl`. A detail request is made only when a notification is new or its timestamp changed. Review decisions carry their own freshness stamp. The file is append-only during normal polling and is compacted to the newest records that fit when it exceeds `cacheMaxBytes`.

**Failure.** A failed poll leaves the last known list visible and labels it cached rather than emptying the inbox. Read-only requests retry four times with exponential backoff from 1s to 30s, and an explicit `Retry-After` from GitHub wins. The status line names the actual failure — a timeout, a rate limit, or whatever `gh` printed — rather than assuming. Single-resource requests time out after 45 seconds; the paginated notifications sweep gets 180, because one `gh --paginate` invocation covers many HTTP requests and the shorter timeout kills it mid-walk. Once GitHub reports a secondary rate limit, the refresh stops making new detail requests and answers from cache. **Approvals are never retried**, because replaying one can duplicate the action.

**Shutdown.** Cleanup aborts any `gh` request in flight. Without that, a request running when Paseo stops the plugin keeps the subprocess alive for its full 45-second attempt timeout and then answers over an IPC channel the host already closed, which crashes the subprocess and stalls the `paseo plugin reload` that asked it to stop.

**Background polling.** The sidebar item and inbox share one review-list query per plugin installation. The sidebar displays the unread count from that list, so read/unread changes, rollbacks, and successful approvals update the count immediately. Opening the inbox reuses a fresh result. Polling uses `refreshIntervalMs` and runs while either UI is mounted; hiding the sidebar item stops its observer. Offline hosts and failed requests hide the count, and reconnecting refreshes stale data.

## Development

```sh
npm run typecheck
npm run lint
npm test
paseo plugin reload paseo-review
paseo plugin logs paseo-review
```

Runtime entries and directories define the boundaries enforced by Paseo's compiler:

| Path               | Runs in                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `index.client.tsx` | The app. Registers the screen, custom sidebar item, and command.          |
| `index.server.ts`  | The daemon subprocess. Registers RPC handlers and shutdown cleanup.       |
| `client/`          | The app. React, the surface, workspace creation, navigation.              |
| `server/`          | The daemon subprocess. `gh`, the filesystem, filters, cache.              |
| `shared/`          | Both. Zod RPC contracts, data types, diff parsing, and status formatting. |

Importing from `server/` in client code, or from `client/` in server code, fails compilation. Shared code must work in both runtimes. Runtime modules belong in these directories; the former `.client`, `.server`, and `.shared` filename suffixes do not define boundaries.

`server/filters.test.ts` covers review-state materialization, configuration filters, and persistent unread state. `server/progress.test.ts` covers the refresh phase sequence, single-flight sharing, ordering, and status formatting. `server/reviews.test.ts` covers approvals overlapping refreshes. `client/reviews.test.ts` covers the shared sidebar/inbox query, read-state rollback, approval counts, and isolation between hosts. `client/inbox.test.tsx` covers selection during approval, bulk read actions, and failure recovery; `client/card.test.tsx` covers the row action menu. `server/settings.test.ts` covers repository mappings and concurrent read-state persistence; `client/workspace.test.ts` covers review workspace creation and agent configuration; `shared/diff.test.ts` covers diff parsing.

Install the declared development dependencies before typechecking or testing. The `@getpaseo/plugin` dependency uses `vendor/getpaseo-plugin-0.10.0-7b0cace99.tgz`, built from unmodified upstream SDK source at commit `7b0cace991f32aba9e36f714be1921219a091843`. The archive supplies declarations for the custom sidebar API until it reaches a published SDK. Keep it and the lockfile in source control; Paseo supplies the runtime modules.

To regenerate it, build the matching upstream checkout, then pack its plugin package:

```sh
npm --prefix /path/to/upstream-paseo run build:client:clean
npm --prefix /path/to/upstream-paseo run build:plugin:clean
npm pack /path/to/upstream-paseo/packages/plugin --ignore-scripts --pack-destination vendor
```

Rename the archive to include the source commit, update the `file:vendor/...` dependency, and run `npm install`. Switch to the published SDK and remove the archive once that release includes the custom sidebar API.

Import hooks and client contribution types from `@getpaseo/plugin/client`, server contexts from `@getpaseo/plugin/server`, and shared contracts from `@getpaseo/plugin`. The sidebar uses `SidebarRow` from `@getpaseo/plugin/client/ui`; it and the inbox use the installation's shared React Query cache. No fork-specific SDK extensions are required.

## Not ported

The TUI's own reading surface: the diff pane, issue-comment pane, and debug log. Paseo's pull-request panel covers the first two, and `paseo plugin logs` covers the third. Session-persisted approvals are also not carried over — approving hides the PR immediately and the next poll confirms it against GitHub.
