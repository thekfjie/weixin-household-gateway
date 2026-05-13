import { UserRole } from "../config/types.js";

export interface SessionMemoryState {
  routeMode?: UserRole;
  turnCount?: number;
  estimatedTokenCount?: number;
  carryoverSummary?: string;
  carryoverSourceSessionId?: string;
  carryoverSourceLastActiveAt?: string;
  pendingInboundAttachments?: PendingInboundAttachment[];
  outputProgressEnabled?: boolean;
  familyApiStreamingEnabled?: boolean;
}

export interface PendingInboundAttachment {
  id: string;
  kind: "image" | "file";
  fileName: string;
  receivedAt: string;
  localPath?: string;
  sizeBytes?: number;
  md5?: string;
  downloadStatus: "ready" | "failed";
  errorMessage?: string;
}

function parsePendingInboundAttachment(
  value: unknown,
): PendingInboundAttachment | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind === "image" || record.kind === "file"
    ? record.kind
    : undefined;
  const downloadStatus =
    record.downloadStatus === "ready" || record.downloadStatus === "failed"
      ? record.downloadStatus
      : undefined;
  if (
    typeof record.id !== "string" ||
    !kind ||
    typeof record.fileName !== "string" ||
    typeof record.receivedAt !== "string" ||
    !downloadStatus
  ) {
    return undefined;
  }

  return {
    id: record.id,
    kind,
    fileName: record.fileName,
    receivedAt: record.receivedAt,
    ...(typeof record.localPath === "string"
      ? { localPath: record.localPath }
      : {}),
    ...(typeof record.sizeBytes === "number"
      ? { sizeBytes: record.sizeBytes }
      : {}),
    ...(typeof record.md5 === "string" ? { md5: record.md5 } : {}),
    downloadStatus,
    ...(typeof record.errorMessage === "string"
      ? { errorMessage: record.errorMessage }
      : {}),
  };
}

export function parseSessionMemory(memoryJson: string): SessionMemoryState {
  try {
    const parsed = JSON.parse(memoryJson) as Record<string, unknown>;
    return {
      ...(parsed.routeMode === "admin" || parsed.routeMode === "family"
        ? { routeMode: parsed.routeMode }
        : {}),
      ...(typeof parsed.turnCount === "number" && parsed.turnCount >= 0
        ? { turnCount: parsed.turnCount }
        : {}),
      ...(typeof parsed.estimatedTokenCount === "number" &&
      parsed.estimatedTokenCount >= 0
        ? { estimatedTokenCount: parsed.estimatedTokenCount }
        : {}),
      ...(typeof parsed.carryoverSummary === "string"
        ? { carryoverSummary: parsed.carryoverSummary }
        : {}),
      ...(typeof parsed.carryoverSourceSessionId === "string"
        ? { carryoverSourceSessionId: parsed.carryoverSourceSessionId }
        : {}),
      ...(typeof parsed.carryoverSourceLastActiveAt === "string"
        ? { carryoverSourceLastActiveAt: parsed.carryoverSourceLastActiveAt }
        : {}),
      ...(Array.isArray(parsed.pendingInboundAttachments)
        ? {
            pendingInboundAttachments: parsed.pendingInboundAttachments
              .map(parsePendingInboundAttachment)
              .filter(
                (item): item is PendingInboundAttachment => Boolean(item),
              ),
          }
        : {}),
      ...(typeof parsed.outputProgressEnabled === "boolean"
        ? { outputProgressEnabled: parsed.outputProgressEnabled }
        : {}),
      ...(typeof parsed.familyApiStreamingEnabled === "boolean"
        ? { familyApiStreamingEnabled: parsed.familyApiStreamingEnabled }
        : {}),
    };
  } catch {
    return {};
  }
}

export function stringifySessionMemory(state: SessionMemoryState): string {
  return JSON.stringify(state);
}

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  return Math.ceil(trimmed.length / 4);
}
