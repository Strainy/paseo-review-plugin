import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { ReviewInbox } from "./client/inbox";
import { ReviewSettings, SETTINGS_SCREEN_ID } from "./client/settings";
import { ReviewSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  if (typeof client.addScreen !== "function" || typeof client.addSidebarHeaderItem !== "function") {
    throw new Error(
      "Reviews requires a Paseo app build with custom sidebar items (upstream #5685). Update the app.",
    );
  }
  // Apps that predate plugin settings screens keep the file-only configuration.
  const canConfigure =
    typeof client.addSettingsScreen === "function" && typeof client.openSettings === "function";
  const openSettings = canConfigure ? () => client.openSettings(SETTINGS_SCREEN_ID) : undefined;

  function Inbox(props: PluginScreenProps) {
    return <ReviewInbox {...props} onOpenSettings={openSettings} />;
  }

  client.addScreen({ id: "inbox", title: "Reviews", Component: Inbox });
  client.addSidebarHeaderItem({
    id: "inbox",
    title: "Reviews",
    Component: ReviewSidebarItem,
  });

  client.addCommandCenterItem({
    id: "open-reviews",
    title: "Open review inbox",
    icon: "GitPullRequestArrow",
    keywords: ["pr", "pull request", "review"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "inbox" });
    },
  });

  if (canConfigure) {
    client.addSettingsScreen({
      id: SETTINGS_SCREEN_ID,
      title: "Review inbox",
      icon: "SlidersHorizontal",
      Component: ReviewSettings,
    });
    client.addCommandCenterItem({
      id: "configure-reviews",
      title: "Configure review inbox",
      icon: "Settings",
      keywords: ["pr", "pull request", "review", "settings", "filters"],
      context: "global",
      onSelect({ openSettings: open }) {
        open(SETTINGS_SCREEN_ID);
      },
    });
  }

  return () => {};
}
