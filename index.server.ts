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
  writeReviewSettings,
} from "./server/reviews";
import {
  approveReview,
  listReviews,
  mapRepository,
  pullRequestDetail,
  readProgress,
  setPullRequestUnread,
} from "./shared/reviews";
import { readSettings, writeSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.handle(listReviews, list);
  server.handle(readProgress, readRefreshProgress);
  server.handle(approveReview, approve);
  server.handle(setPullRequestUnread, setUnread);
  server.handle(pullRequestDetail, detail);
  server.handle(mapRepository, mapRepositoryProject);
  server.handle(readSettings, readReviewSettings);
  server.handle(writeSettings, writeReviewSettings);

  return () => {
    stopReviews();
  };
}
