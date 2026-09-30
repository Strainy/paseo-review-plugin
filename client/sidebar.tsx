import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { useReviewList } from "./use-reviews";

export function ReviewSidebarItem({
  theme,
  host,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const { reviews, unreadCount, isOnline } = useReviewList(host.id);
  const showCount = isOnline && !reviews.isError && unreadCount > 0;
  return (
    <SidebarRow
      icon="GitPullRequestArrow"
      active={currentScreen?.screenId === "inbox"}
      onPress={() => openScreen({ screenId: "inbox" })}
      trailing={
        showCount ? (
          <Text
            testID="review-sidebar-count"
            accessibilityLabel={`${unreadCount} unread reviews`}
            style={{
              minWidth: 20,
              paddingHorizontal: 6,
              borderRadius: 10,
              lineHeight: 20,
              fontSize: 11,
              fontWeight: "500",
              textAlign: "center",
              color: theme.colors.foregroundMuted,
              backgroundColor: theme.colors.surface2,
            }}
          >
            {unreadCount}
          </Text>
        ) : null
      }
    />
  );
}
