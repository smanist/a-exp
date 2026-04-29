/** Question marker protocol for Slack-human interaction during sessions.
 *
 *  Enables skills to post questions to Slack and end the session gracefully,
 *  with continuation detection when the user replies.
 *
 *  Flow:
 *  1. Skill detects it needs human input (e.g., /project scaffold interview)
 *  2. Skill posts questions via `[QUESTION: <id>]...[/QUESTION]` marker
 *  3. Session ends after posting
 *  4. Chat agent detects marker, stores pending question
 *  5. User replies in Slack
 *  6. Chat agent detects continuation, spawns new deep work with answers
 */

export interface PendingQuestion {
  questionId: string;
  skillName: string;
  mode?: string;
  questions: string[];
  partialState: Record<string, unknown>;
  askedAt: number;
}

const PENDING_QUESTIONS_TTL_MS = 30 * 60 * 1000; // 30 minutes

const pendingQuestions = new Map<string, PendingQuestion>();

const QUESTION_REGEX = /\[QUESTION:\s*([^\]]+)\]([\s\S]*?)\[\/QUESTION\]/;

export function formatQuestionMarker(
  questionId: string,
  questions: string[],
  metadata?: { skillName?: string; mode?: string; partialState?: Record<string, unknown> },
): string {
  const escapedQuestions = questions.map((q) =>
    q.replace(/\[\/QUESTION\]/g, "[\\/QUESTION]")
  );
  const content = escapedQuestions.join("\n\n");

  let metaLine = "";
  if (metadata?.skillName || metadata?.mode) {
    const meta: string[] = [];
    if (metadata.skillName) meta.push(`skill="${metadata.skillName}"`);
    if (metadata.mode) meta.push(`mode="${metadata.mode}"`);
    if (metadata.partialState) {
      meta.push(`state="${encodeURIComponent(JSON.stringify(metadata.partialState))}"`);
    }
    metaLine = `\n${meta.join(" ")}`;
  }

  return `[QUESTION: ${questionId}]${metaLine}\n${content}\n[/QUESTION]`;
}

interface ParsedQuestion {
  questionId: string;
  questions: string[];
  skillName?: string;
  mode?: string;
  partialState?: Record<string, unknown>;
}

export function parseQuestionMarker(text: string): ParsedQuestion | null {
  const match = text.match(QUESTION_REGEX);
  if (!match) return null;

  const questionId = match[1].trim();
  const content = match[2].trim();

  const lines = content.split("\n");
  const questionParts: string[] = [];
  let currentBlock: string[] = [];
  let skillName: string | undefined;
  let mode: string | undefined;
  let partialState: Record<string, unknown> | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const skillMatch = trimmed.match(/^skill="([^"]+)"/);
    if (skillMatch) {
      skillName = skillMatch[1];
      continue;
    }
    const modeMatch = trimmed.match(/^mode="([^"]+)"/);
    if (modeMatch) {
      mode = modeMatch[1];
      continue;
    }
    const stateMatch = trimmed.match(/^state="([^"]+)"/);
    if (stateMatch) {
      try {
        partialState = JSON.parse(decodeURIComponent(stateMatch[1]));
      } catch {
        // Invalid state, skip
      }
      continue;
    }
    // Empty line = paragraph break
    if (!trimmed) {
      if (currentBlock.length > 0) {
        questionParts.push(currentBlock.join(" "));
        currentBlock = [];
      }
      continue;
    }
    currentBlock.push(trimmed);
  }
  // Don't forget the last block
  if (currentBlock.length > 0) {
    questionParts.push(currentBlock.join(" "));
  }

  const finalQuestions = questionParts
    .map((q) => q.replace(/\[\\\/QUESTION\]/g, "[/QUESTION]"))
    .filter(Boolean);

  return { questionId, questions: finalQuestions, skillName, mode, partialState };
}

export function setPendingQuestion(
  threadKey: string,
  question: PendingQuestion,
): void {
  pendingQuestions.set(threadKey, question);
}

export function getPendingQuestion(threadKey: string): PendingQuestion | null {
  const pending = pendingQuestions.get(threadKey);
  if (!pending) return null;

  if (Date.now() - pending.askedAt > PENDING_QUESTIONS_TTL_MS) {
    pendingQuestions.delete(threadKey);
    return null;
  }

  return pending;
}

export function clearPendingQuestion(threadKey: string): void {
  pendingQuestions.delete(threadKey);
}

export function isWaitingForAnswer(threadKey: string): boolean {
  return getPendingQuestion(threadKey) !== null;
}

export function cleanupExpiredQuestions(): void {
  const now = Date.now();
  for (const [key, pending] of pendingQuestions) {
    if (now - pending.askedAt > PENDING_QUESTIONS_TTL_MS) {
      pendingQuestions.delete(key);
    }
  }
}
