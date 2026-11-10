/** License capability that lets a member act as its team's control session. */
export const LEAD_CAPABILITY = 'team:lead';

/**
 * License capability for the independent shadow/secretary role. A shadow may
 * do everything the captain can do across the team control plane, but it keeps
 * its own member identity and token; it never becomes the admin/captain
 * principal. There is at most one active shadow in a workspace.
 */
export const SHADOW_CAPABILITY = 'captain:delegate';

/** Capabilities a caller may grant; anything else is a typo or an injection. */
export const KNOWN_CAPABILITIES = Object.freeze([
  LEAD_CAPABILITY,
  SHADOW_CAPABILITY,
  'task:continue',
]);

const ROLE_DEFAULTS = {
  engineer: { label: 'Engineer', kinds: ['work', 'implementation', 'repair'], toolPolicy: 'workspace-write', capabilities: [] },
  implementer: { label: 'Engineer', roleKey: 'engineer', kinds: ['work', 'implementation', 'repair'], toolPolicy: 'workspace-write', capabilities: [] },
  analyst: { label: 'Analyst', kinds: ['requirements', 'verification'], toolPolicy: 'read-only', capabilities: [] },
  // A reviewer may restart a failed task with "继续" (agent_teams_continue_task).
  reviewer: { label: 'Reviewer', kinds: ['review', 'requirements', 'verification'], toolPolicy: 'read-only', capabilities: ['task:continue'] },
  auditor: { label: 'Reviewer', roleKey: 'reviewer', kinds: ['review', 'requirements', 'verification'], toolPolicy: 'read-only', capabilities: ['task:continue'] },
  integrator: { label: 'Integrator', kinds: ['integration'], toolPolicy: 'workspace-write', capabilities: [] },
  merger: { label: 'Integrator', roleKey: 'integrator', kinds: ['integration'], toolPolicy: 'workspace-write', capabilities: [] },
  lead: {
    label: 'Lead',
    kinds: ['work', 'requirements'],
    toolPolicy: 'workspace-write',
    capabilities: [LEAD_CAPABILITY, 'task:continue'],
  },
  shadow: {
    label: 'Shadow',
    // The shadow is a control session, not a delivery worker. An empty kind
    // list keeps it out of automatic implementation/repair assignment while
    // still allowing it to manage the team through the control API.
    kinds: [],
    toolPolicy: 'workspace-write',
    capabilities: [SHADOW_CAPABILITY, 'task:continue'],
    control: true,
    scope: 'global',
  },
};

export function normalizeRole(role) {
  const value = String(role ?? 'engineer').trim().toLowerCase();
  if (value === 'worker' || value === 'dev' || value === 'developer') return 'engineer';
  if (value === 'auditor' || value === 'checker') return 'reviewer';
  if (value === 'merge' || value === 'merger') return 'integrator';
  if (['shadow', 'deputy', 'secretary', 'captain-delegate', '小队长'].includes(value)) return 'shadow';
  return value || 'engineer';
}

export function roleDefaults(role) {
  const roleKey = normalizeRole(role);
  const defaults = ROLE_DEFAULTS[roleKey] ?? {
    label: roleKey.charAt(0).toUpperCase() + roleKey.slice(1),
    kinds: ['work'],
    toolPolicy: 'workspace-write',
    capabilities: [],
  };
  return {
    roleKey: defaults.roleKey ?? roleKey,
    label: defaults.label,
    kinds: defaults.kinds,
    toolPolicy: defaults.toolPolicy,
    capabilities: defaults.capabilities ?? [],
    control: defaults.control === true,
    scope: defaults.scope ?? 'team',
  };
}

/**
 * Normalize a requested capability list against its role.
 *
 * Authority capabilities are role-bound: `team:lead` only exists on a lead and
 * `captain:delegate` only on a shadow. Merely adding the capability to some
 * other role must not grant control access, and a role=lead/shadow seat must
 * always carry its capability so it cannot hide from the control-seat checks.
 */
export function resolveCapabilities(role, requested) {
  const roleKey = normalizeRole(role);
  const list = Array.isArray(requested) ? requested : [];
  const unknown = [...new Set(list.filter((capability) => !KNOWN_CAPABILITIES.includes(capability)))];
  if (unknown.length > 0) {
    throw Object.assign(
      new Error(`unknown capability: ${unknown.join(', ')}`),
      { status: 400, code: 'E_CAPABILITY_UNKNOWN' },
    );
  }
  const capabilities = new Set(list);
  if (roleKey === 'lead') capabilities.add(LEAD_CAPABILITY);
  if (roleKey === 'shadow') capabilities.add(SHADOW_CAPABILITY);
  if (roleKey !== 'lead' && capabilities.has(LEAD_CAPABILITY)) {
    throw Object.assign(
      new Error('team:lead is reserved for the lead role'),
      { status: 400, code: 'E_LEAD_CAPABILITY' },
    );
  }
  if (roleKey !== 'shadow' && capabilities.has(SHADOW_CAPABILITY)) {
    throw Object.assign(
      new Error('captain:delegate is reserved for the shadow role'),
      { status: 400, code: 'E_SHADOW_CAPABILITY' },
    );
  }
  return [...capabilities];
}

export function nextMemberLabel(memberNames, base) {
  const names = new Set(memberNames);
  let index = 1;
  for (;;) {
    const candidate = `${base} ${String(index).padStart(2, '0')}`;
    if (!names.has(candidate)) return candidate;
    index += 1;
  }
}
