/** Slack file upload helpers. Separated from slack.ts for testability. */

import type { WebClient } from "@slack/web-api";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileUpload {
  /** File content buffer. */
  buffer: Buffer;
  /** Filename (e.g., "model.glb"). Defaults to "file". */
  filename?: string;
  /** Display title in Slack. */
  title?: string;
  /** Alt text for screen readers. */
  altText?: string;
}

/** @deprecated Use FileUpload instead. */
export type ImageUpload = FileUpload;

/** Result from a file upload operation. */
export interface UploadResult {
  ok: boolean;
  /** Number of files successfully uploaded. */
  count: number;
  error?: string;
}

// ── Pure helpers (testable) ──────────────────────────────────────────────────

/** Build the arguments object for client.files.uploadV2().
 *  Returns null if files is empty.
 *  Single file → flat args. Multiple files → file_uploads array. */
export function buildFileUploadArgs(
  files: FileUpload[],
  channelId: string,
  threadTs?: string,
  initialComment?: string,
): Record<string, unknown> | null {
  if (files.length === 0) return null;

  const base: Record<string, unknown> = {
    channel_id: channelId,
  };
  if (threadTs) base.thread_ts = threadTs;
  if (initialComment) base.initial_comment = initialComment;

  if (files.length === 1) {
    const f = files[0];
    return {
      ...base,
      file: f.buffer,
      filename: f.filename ?? "file",
      title: f.title,
      alt_text: f.altText,
    };
  }

  const fileUploads = files.map((f) => ({
    file: f.buffer,
    filename: f.filename ?? "file",
    title: f.title,
    alt_text: f.altText,
  }));

  return {
    ...base,
    file_uploads: fileUploads,
  };
}

// ── Slack API callers ────────────────────────────────────────────────────────

/** Upload files to a Slack channel via files.uploadV2.
 *  Handles both single and multi-file uploads. Any file type is supported. */
export async function uploadFiles(
  client: WebClient,
  channelId: string,
  files: FileUpload[],
  opts?: { threadTs?: string; initialComment?: string },
): Promise<UploadResult> {
  const args = buildFileUploadArgs(
    files,
    channelId,
    opts?.threadTs,
    opts?.initialComment,
  );

  if (!args) return { ok: true, count: 0 };

  try {
    await client.filesUploadV2(args as unknown as Parameters<WebClient["filesUploadV2"]>[0]);
    return { ok: true, count: files.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[slack-files] Upload failed: ${msg}`);
    return { ok: false, count: 0, error: msg };
  }
}

/** @deprecated Use uploadFiles instead. */
export const uploadImages = uploadFiles;
