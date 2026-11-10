// Acknowledging stop or close is not proof that a session lost side effects.
// Preserve the first error and retain the reservation until verification.
export async function cleanupContractorSession(adapter, sessionId) {
  let cleanupError;
  try {
    const stopped = await adapter.stop({ sessionId });
    if (stopped?.ok !== true) cleanupError = stopped?.warning || 'contractor stop not confirmed';
  } catch (error) {
    cleanupError = (error instanceof Error ? error.message : String(error)) || 'contractor stop failed';
  }
  try {
    const closed = await adapter.close?.({ sessionId });
    if (closed?.ok !== true) cleanupError = cleanupError ?? (closed?.warning || 'contractor close not confirmed');
  } catch (error) {
    cleanupError = cleanupError ?? ((error instanceof Error ? error.message : String(error)) || 'contractor close failed');
  }
  if (cleanupError) return cleanupError;
  let proof;
  try { proof = await adapter.verifySessionTermination?.({ sessionId }); } catch (error) {
    return (error instanceof Error ? error.message : String(error)) || 'contractor termination verification failed';
  }
  if (proof?.verified !== true || proof.sessionId !== sessionId || proof.sideEffectsRevoked !== true) {
    return 'contractor termination and side-effect revocation not proven';
  }
  return cleanupError;
}
