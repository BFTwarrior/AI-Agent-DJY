const ACTIVE_CONTRACTOR_STATUSES = new Set(['starting', 'running', 'cancelling', 'cleanup_error']);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_INVALID' });
}

const SLOT_ALIASES = { main: 'patrol' };

function canonicalSlot(slot) {
  return SLOT_ALIASES[slot] ?? slot;
}

function settingsFor(slotsConfig, slot) {
  const canonical = canonicalSlot(slot);
  return slotsConfig?.[canonical]
    ?? (canonical === 'patrol' ? slotsConfig?.main : undefined);
}

function reviewCapacity(reviewPool) {
  if (reviewPool === undefined || reviewPool === null) return 0;
  if (typeof reviewPool === 'object' && reviewPool.enabled === false) {
    if (reviewPool.capacity !== undefined && reviewPool.capacity !== 0) throw invalid('disabled reviewPool capacity must be 0');
    return 0;
  }
  if (typeof reviewPool !== 'object' || reviewPool.enabled !== true
    || !Number.isInteger(reviewPool.capacity) || reviewPool.capacity < 1 || reviewPool.capacity > 10) {
    throw invalid('reviewPool must be disabled or enabled with capacity 1..10');
  }
  return reviewPool.capacity;
}

export function resolveContractorSlot(purpose, requestedSlot, slotsConfig, reviewPool) {
  const text = String(purpose ?? 'task');
  const mergePurpose = /^(post_merge_review|merge_verify|merge_review|merge)(?::|$)/.test(text);
  const capacity = reviewCapacity(reviewPool);
  const reviewPurpose = /^(independent_review)(?::|$)/.test(text);
  if (requestedSlot === 'review' || requestedSlot === 'reviewPool') {
    if (capacity === 0) throw invalid('independent review pool is disabled');
    if (!reviewPurpose) throw invalid('review pool only accepts independent_review purposes');
    return 'review';
  }
  if (reviewPurpose) {
    if (capacity === 0) throw invalid('independent review pool is disabled');
    throw invalid('independent_review must use the review contractor pool');
  }
  const canonical = canonicalSlot(requestedSlot ?? (mergePurpose ? 'merge' : 'patrol'));
  if (!['merge', 'patrol'].includes(canonical)) throw invalid(`unknown contractor slot: ${canonical}`);
  if (canonical === 'merge' && !mergePurpose) throw invalid('contractors.slots.merge only accepts merge review/verification purposes');
  if (canonical === 'patrol' && mergePurpose) throw invalid('merge review/verification must use the merge contractor slot');
  const settings = settingsFor(slotsConfig, canonical);
  if (!settings) throw invalid(`contractor slot is not configured: ${canonical}`);
  // Keep the persisted slot name stable for legacy configurations that still
  // use `main`; new configurations should use `patrol`.
  const slot = slotsConfig?.[canonical] ? canonical : (canonical === 'patrol' && slotsConfig?.main ? 'main' : canonical);
  const kind = text.split(':')[0];
  const allowed = Array.isArray(settings.kinds) ? settings.kinds : ['*'];
  if (!allowed.includes('*') && !allowed.includes(kind)) throw invalid(`contractor purpose ${kind} is not allowed in slot ${slot}`);
  return slot;
}

export function contractorSlotCap(slotsConfig, slot, reviewPool) {
  if (slot === 'review' || slot === 'reviewPool') return reviewCapacity(reviewPool);
  reviewCapacity(reviewPool);
  const cap = Number(settingsFor(slotsConfig, slot)?.cap ?? 0);
  return Number.isFinite(cap) ? Math.max(0, cap) : 0;
}

export function contractorSlotAllows(slotsConfig, slot, purpose) {
  const settings = settingsFor(slotsConfig, slot);
  if (!settings) return false;
  const kind = String(purpose ?? 'task').split(':')[0];
  const allowed = Array.isArray(settings.kinds) ? settings.kinds : ['*'];
  return allowed.includes('*') || allowed.includes(kind);
}

export function activeContractors(store, slot) {
  return store.listAllContractors()
    .filter((item) => (slot ? item.slot === slot : true) && ACTIVE_CONTRACTOR_STATUSES.has(item.status));
}

export function contractorPools(store, slotsConfig, reviewPool) {
  const capacity = reviewCapacity(reviewPool);
  const pools = Object.entries(slotsConfig ?? {})
    .filter(([, settings]) => settings && typeof settings === 'object')
    .map(([slot, settings]) => {
    const records = store.listAllContractors(undefined, slot);
    const active = records.filter((item) => ACTIVE_CONTRACTOR_STATUSES.has(item.status));
    const queued = records.filter((item) => item.status === 'queued');
    return {
      slot,
      cap: Math.max(0, Number(settings.cap ?? 0)),
      active: active.length,
      queued: queued.length,
      running: active.map((item) => ({ id: item.id, teamId: item.teamId, purpose: item.purpose, status: item.status })),
    };
  });
  if (capacity > 0) {
    const records = store.listAllContractors(undefined, 'review')
      .filter((item) => item.purpose === 'independent_review');
    const active = records.filter((item) => ACTIVE_CONTRACTOR_STATUSES.has(item.status));
    const queued = records.filter((item) => item.status === 'queued');
    pools.push({
      slot: 'review', cap: capacity, active: active.length, queued: queued.length,
      running: active.map((item) => ({ id: item.id, teamId: item.teamId, purpose: item.purpose, status: item.status })),
    });
  }
  return pools;
}
