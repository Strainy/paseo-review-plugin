import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  approve,
  detail,
  list,
  mapRepositoryProject,
  readRefreshProgress,
  readReviewSettings,
  setUnread,
  stopReviews,
} from "./server/reviews";
import {
  approveReview,
  listReviews,
  mapRepository,
  pullRequestDetail,
  readProgress,
  readSettings,
  setPullRequestUnread,
} from "./shared/reviews";

export default function contribute(server: PluginServerContext) {
  server.handle(listReviews, list);
  server.handle(readProgress, readRefreshProgress);
  server.handle(approveReview, approve);
  server.handle(setPullRequestUnread, setUnread);
  server.handle(pullRequestDetail, detail);
  server.handle(mapRepository, mapRepositoryProject);
  server.handle(readSettings, readReviewSettings);

  return () => {
    stopReviews();
  };
}
