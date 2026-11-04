import { describe, expect, it } from "vitest";
import { zcodeBackgroundTaskNotificationToolUpdateStatus } from "../src/background-task-notifications.js";

describe("background task notifications", () => {
  it("preserves stopped task-notification status and normalizes killed to stopped", () => {
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus("stopped")).toBe("stopped");
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus("killed")).toBe("stopped");
  });

  it("normalizes terminal task-notification status", () => {
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus("completed")).toBe("completed");
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus("failed")).toBe("failed");
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus("lost")).toBe("failed");
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus("unexpected")).toBe("completed");
    expect(zcodeBackgroundTaskNotificationToolUpdateStatus(undefined)).toBe("completed");
  });

});
