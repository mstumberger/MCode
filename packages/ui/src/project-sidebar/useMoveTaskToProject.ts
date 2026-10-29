import { useCallback } from "react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import type {
  IProjectService,
  ProjectTaskRef,
  VirtualProject,
} from "@/project-sidebar/contract.js";

/**
 * 任务移动到项目的唯一 UI 命令路径：拖放落点与右键「移到项目」共用同一
 * moveTask 调用、缺 root 确认重试与失败 toast 语义，不新增第二条写入路径。
 */
export function useMoveTaskToProject(
  service: IProjectService | undefined,
  refresh: () => Promise<void>,
) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  return useCallback(
    (task: ProjectTaskRef, project: Pick<VirtualProject, "id" | "hostId">) => {
      void (async () => {
        if (!service) return;
        try {
          await service.moveTask({ task, projectId: project.id, hostId: project.hostId });
        } catch (cause) {
          // 缺 root 只在本地项目允许确认后原子补目录；远端单 root 拒绝保持原树。
          if (
            project.hostId !== "local" ||
            !String(cause).includes("project.root-confirmation-required")
          )
            throw cause;
          if (
            !(await confirm({
              title: intl.formatMessage({ id: "project.addFolder" }),
              description: task.workspacePath,
            }))
          )
            return;
          await service.moveTask({
            task,
            projectId: project.id,
            hostId: project.hostId,
            addMissingRoot: true,
          });
        }
        await refresh();
      })().catch((cause) => {
        logger.error("[project-sidebar] 移动任务失败", cause);
        toast(String(cause));
      });
    },
    [service, refresh, confirm, intl],
  );
}
