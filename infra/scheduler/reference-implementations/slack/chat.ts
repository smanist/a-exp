export interface ProcessMessageOpts {
  onProgress?: (text: string) => Promise<void>;
  onComplete?: (text: string | null) => Promise<void>;
  threadMessages?: any;
  [key: string]: unknown;
}

export async function processMessage(
  _raw: string,
  _convKey: string,
  _repoDir: string,
  _store: unknown,
  _callbacks: ProcessMessageOpts = {},
  _opts: unknown = {},
): Promise<{ text: string } | { sessionId: string }> {
  return { text: "Full Slack chat is a runnable reference in a-exp Core. Wire processMessage to your active chat runtime before using it in production." };
}

export function clearConversation(_convKey: string): void {
  // Reference shim.
}
