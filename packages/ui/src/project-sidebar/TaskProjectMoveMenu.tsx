import {
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuItem,
} from "@/components/ui/context-menu.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { projectKey, taskProjectMoveCandidates } from "@/project-sidebar/view.js";
import { useMoveTaskToProject } from "@/project-sidebar/useMoveTaskToProject.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 任务行右键「移到项目」：与拖放共用 moveTask 命令路径；候选与禁用规则见 taskProjectMoveCandidates。 */
export function TaskProjectMoveMenu({ task }: { task: ProjectTask }) {
  const { projects, availability, service, refresh } = useProjectDirectory();
  const { intl } = useZCodeIntl();
  const move = useMoveTaskToProject(service, refresh);
  if (!service || task.archived) return null;
  const candidates = taskProjectMoveCandidates(projects, task, availability);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="task-project-move-menu">
        {intl.formatMessage({ id: "project.moveTask" })}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {candidates.map(({ project, disabled }) => {
          const offline = availability.get(projectKey(project))?.online === false;
          return (
            <ContextMenuItem
              key={projectKey(project)}
              disabled={disabled}
              data-task-project-move-target={project.id}
              onSelect={() =>
                move(
                  {
                    workspacePath: task.workspacePath,
                    ...(task.workspaceIdentity?.trim()
                      ? { workspaceIdentity: task.workspaceIdentity }
                      : {}),
                    taskId: task.taskId,
                  },
                  project,
                )
              }
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {offline ? (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: "project.offline" })}
                </span>
              ) : null}
            </ContextMenuItem>
          );
        })}
        {!candidates.length ? (
          <ContextMenuItem disabled>
            {intl.formatMessage({ id: "project.moveTaskNoProjects" })}
          </ContextMenuItem>
        ) : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
