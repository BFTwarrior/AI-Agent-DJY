/** Count control-seat occupancy through the TeamService store/classification seams. */
export function countControlSessions(service) {
  const teams = service.store.listTeams(true);
  const occupied = new Set();
  collectTeamSessions(service, teams, occupied, {
    controlOnly: true,
    captainStartPrefix: 'pending',
    captainConflictPrefix: 'conflict',
  });
  return occupied.size;
}

/** Count all workspace member, reservation and active-contractor occupancy. */
export function countWorkspaceSessions(service) {
  const occupied = new Set();
  collectTeamSessions(service, service.store.listTeams(true), occupied, {
    controlOnly: false,
    captainStartPrefix: 'captain',
    captainConflictPrefix: 'captain-conflict',
  });
  for (const contractor of service.activeContractors()) {
    occupied.add(contractor.sessionId ? `session:${contractor.sessionId}` : `contractor:${contractor.id}`);
  }
  return occupied.size;
}

function collectTeamSessions(service, teams, occupied, {
  controlOnly, captainStartPrefix, captainConflictPrefix,
}) {
  for (const team of teams) {
    if (team.captainSessionId) occupied.add(`session:${team.captainSessionId}`);
    const start = team.captainSessionStart;
    if (['starting', 'unknown'].includes(start?.state)) {
      occupied.add(start.sessionId ? `session:${start.sessionId}` : `${captainStartPrefix}:${team.id}:${start.operationId}`);
    }
    for (const conflict of Array.isArray(team.captainSessionConflicts) ? team.captainSessionConflicts : []) {
      occupied.add(conflict.sessionId ? `session:${conflict.sessionId}` : `${captainConflictPrefix}:${team.id}:${conflict.operationId}`);
    }
    for (const conflict of Array.isArray(team.workerSessionConflicts) ? team.workerSessionConflicts : []) {
      if (!controlOnly || conflict.control) {
        occupied.add(conflict.sessionId ? `session:${conflict.sessionId}` : `worker-conflict:${team.id}:${conflict.operationId}`);
      }
    }
    for (const member of service.store.listMembers(team.id)) {
      if (controlOnly) collectControlMember(service, member, occupied);
      else collectWorkspaceMember(member, occupied);
    }
  }
}

function collectControlMember(service, member, occupied) {
  // Keep classification at the same read points as the public service seam.
  if (member.sessionId && service.memberIsControl(member)) occupied.add(`session:${member.sessionId}`);
  else if (service.memberIsControl(member) && member.shadowState === 'starting') {
    occupied.add(`shadow:${member.id}:${member.shadowStartId}`);
  }
  const start = member.workerSessionStart;
  if (service.memberIsControl(member) && ['starting', 'unknown'].includes(start?.state)) {
    occupied.add(start.sessionId ? `session:${start.sessionId}` : `worker:${member.id}:${start.operationId}`);
  }
}

function collectWorkspaceMember(member, occupied) {
  if (member.sessionId) occupied.add(`session:${member.sessionId}`);
  else if (member.shadowState === 'starting') occupied.add(`shadow:${member.id}:${member.shadowStartId}`);
  const start = member.workerSessionStart;
  if (['starting', 'unknown'].includes(start?.state)) {
    occupied.add(start.sessionId ? `session:${start.sessionId}` : `worker:${member.id}:${start.operationId}`);
  }
}
