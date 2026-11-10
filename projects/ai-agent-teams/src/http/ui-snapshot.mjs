import { taskDeliveryState, taskVisualState } from '../domain/scheduler.mjs';

export function buildUiSnapshot({ store, service, version }) {
  const teams = store.listTeams().slice(0, 2).map((team) => {
    // Hidden tasks remain in history but are intentionally excluded from the live projection.
    const tasks = store.listTasks(team.id).filter((task) => task.hidden !== true);
    const currentByAssignee = new Map(
      tasks
        .filter((task) => ['in_progress', 'active', 'claimed', 'running'].includes(task.status))
        .map((task) => [task.assignee, task.id]),
    );
    return {
      id: team.id,
      name: team.name ?? team.id,
      phase: team.phase ?? 'running',
      members: store.listMembers(team.id)
        .filter((member) => member.status !== 'removed')
        .map((member) => {
          const assigned = tasks.filter((task) => task.assignee === member.name);
          const doneCount = assigned.filter((task) => ['completed', 'done', 'merged'].includes(task.status)).length;
          return {
            id: member.id,
            name: member.name,
            label: member.label ?? member.name,
            role: member.role ?? member.roleKey ?? 'member',
            status: member.status ?? 'unspawned',
            toolPolicy: member.toolPolicy ?? null,
            residency: member.residency ?? member.status ?? 'unspawned',
            currentTask: currentByAssignee.get(member.name) ?? null,
            taskCount: assigned.length,
            doneCount,
          };
        }),
      tasks: tasks.map((task) => ({
        id: task.id,
        teamId: task.teamId,
        subject: task.subject,
        status: task.status,
        // Queued work is ready but waiting for capacity; it is not a failure state.
        deliveryState: taskDeliveryState(task, tasks),
        visual: taskVisualState(task, tasks),
        priority: task.priority ?? null,
        kind: task.kind ?? 'work',
        round: task.round ?? null,
        dependencies: task.dependencies ?? [],
        assignee: task.assignee ?? null,
        assigneeRole: task.assigneeRole ?? null,
        acceptance: task.acceptance ?? [],
        inScope: task.inScope ?? [],
      })),
      contractors: store.listContractors(team.id).map((contractor) => ({
        slot: contractor.slot ?? null,
        status: contractor.status ?? 'unknown',
        purpose: contractor.purpose ?? null,
      })),
      ...(typeof service?.redReviewSummary === 'function'
        ? { redReviews: service.redReviewSummary(team.id) }
        : {}),
    };
  });
  return { version, teams };
}
