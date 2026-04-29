const maxTurnsPerChannel = new Map<string, number>();
const botReplyCount = new Map<string, number>();

export function setMaxTurns(channelId: string, limit: number): void {
  if (limit <= 0) {
    maxTurnsPerChannel.delete(channelId);
    return;
  }
  maxTurnsPerChannel.set(channelId, limit);
}

export function getMaxTurns(channelId: string): number | null {
  return maxTurnsPerChannel.get(channelId) ?? null;
}

export function removeMaxTurns(channelId: string): boolean {
  return maxTurnsPerChannel.delete(channelId);
}

export function incrementBotReply(convKey: string): number {
  const next = (botReplyCount.get(convKey) ?? 0) + 1;
  botReplyCount.set(convKey, next);
  return next;
}

export function isThreadAtLimit(channelId: string, convKey: string): boolean {
  const limit = maxTurnsPerChannel.get(channelId);
  if (limit === undefined) return false;
  return (botReplyCount.get(convKey) ?? 0) >= limit;
}

export function getThreadLimitMessage(channelId: string): string | null {
  const limit = maxTurnsPerChannel.get(channelId);
  return limit === undefined ? null : `Reached the ${limit}-turn limit for this thread.`;
}
