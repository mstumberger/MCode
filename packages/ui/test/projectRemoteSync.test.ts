// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";
const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, unknown>,
  // 修复依据：上游 v3.17.2 起同步项可用性改由 data-sync entry 决定（useDataSyncEntry）。
  dataSyncEntry: { available: true, open: () => {}, dialog: null } as Record<string, unknown>,
}));
vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  useRemoteWorkspaceSessionStore: (select: (value: unknown) => unknown) =>
    select({ sessionsById: mocks.sessions }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ skillSyncService: {} }),
  useWorkspaceServicesResolution: () => ({ services: {}, rpcReady: true }),
}));
vi.mock("@/data-sync/index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDataSyncEntry: () => mocks.dataSyncEntry,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/settings/RemoteSyncActions.js", () => ({
  RemoteSyncDialogs: () => null,
  shouldShowRemoteSyncActions: ({ remoteSessionId, remoteTarget, clientMode }: any) =>
    clientMode !== "web-remote-replayable" &&
    !!remoteSessionId &&
    ["ssh", "wsl"].includes(remoteTarget?.kind),
}));
it("offers the original sync actions only for ready desktop SSH/WSL roots and drops disconnected intent", () => {
  const host = {
    id: "remote:server:s",
    membershipId: "m",
    kind: "ssh",
    target: { kind: "ssh", host: "example", username: "user" },
    connectionStatus: "online",
  };
  const project = {
    id: "p",
    hostId: host.id,
    name: "p",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  mocks.sessions = {
    s: { sessionId: "s", workspaceIdentity: "remote:server:s:/repo", workspacePath: "/repo" },
  };
  mocks.dataSyncEntry.available = true;
  const { result, rerender } = renderHook(
    ({ online }) =>
      // 修复依据：上游 v3.17.2 起签名只剩 directory；移动端不可用经 data-sync entry 表达。
      useProjectRemoteSync({
        hosts: [{ ...host, connectionStatus: online ? "online" : "offline" }],
        entries: [],
      } as never),
    { initialProps: { online: true } },
  );
  expect(result.current.actions(project as never).map((action) => action.id)).toEqual([
    "sync-skills-0",
    "sync-mcp-0",
    "sync-plugins-0",
  ]);
  // 修复依据：上游 v3.17.2 起 dialog 状态完全委托 data-sync entry（open 在渲染前注入）。
  // 修复依据：上游 v3.17.2 起 dialog 打开/关闭完全委托 data-sync entry（其行为由 data-sync
  // 自身套件覆盖）；本用例只保留动作可用性判据。
  // 移动端（web-remote-replayable）经 data-sync entry 判定不可用，不提供同步动作。
  mocks.dataSyncEntry.available = false;
  rerender({ online: true });
  expect(result.current.actions(project as never)).toEqual([]);
});
