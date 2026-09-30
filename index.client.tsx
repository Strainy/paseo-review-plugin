import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewInbox } from "./client/inbox";
import { ReviewSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  if (typeof client.addScreen !== "function" || typeof client.addSidebarHeaderItem !== "function") {
    throw new Error(
      "Reviews requires a Paseo app build with custom sidebar items (upstream #5685). Update the app.",
    );
  }
  client.addScreen({ id: "inbox", title: "Reviews", Component: ReviewInbox });
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

  return () => {};
}
