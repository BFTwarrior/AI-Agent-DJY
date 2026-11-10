(() => {
  const button = document.querySelector('#top-patrol');
  const model = window.__AGENT_TEAMS_LIVE_MODEL__;
  const teams = Array.isArray(model?.teamMeta)
    ? model.teamMeta.filter((team) => typeof team?.id === 'string' && team.id)
    : [];
  if (!button || teams.length === 0) {
    if (button) button.hidden = true;
    return;
  }

  const report = (message, values) => document.dispatchEvent(new CustomEvent('agent-teams:patrol-result', {
    detail: { message, values },
  }));
  let inFlight = false;

  button.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    button.disabled = true;
    report('正在启动巡检');
    try {
      const outcomes = await Promise.all(teams.map(async (team) => {
        try {
          const response = await fetch(`/api/v1/teams/${encodeURIComponent(team.id)}/patrol`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
          });
          const payload = await response.json();
          if (!response.ok || payload?.ok !== true) return { error: true };
          return { data: payload.data };
        } catch {
          return { error: true };
        }
      }));
      const started = outcomes.filter((outcome) => outcome.data?.ran === true).length;
      const queued = outcomes.some((outcome) => outcome.data?.reason === 'captain-busy-queued');
      const inProgress = outcomes.some((outcome) => outcome.data?.reason === 'patrol-in-flight');
      const disabled = outcomes.some((outcome) => outcome.data?.reason === 'disabled');
      const failed = outcomes.some((outcome) => outcome.error
        || ['error', 'patrol-timeout', 'patrol-cancel-failed'].includes(outcome.data?.reason));

      if (started === teams.length) report('队长已开始巡检');
      else if (started > 0) report('已启动巡检：{0}/{1} 支队伍', [started, teams.length]); else if (queued) report('巡检已排队');
      else if (inProgress) report('巡检已在运行中');
      else if (disabled) report('巡检已关闭');
      else if (failed) report('巡检启动失败');
      else report('没有可巡检的活动任务');
    } finally {
      inFlight = false;
      button.disabled = false;
    }
  });
})();
