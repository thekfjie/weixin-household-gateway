import { spawn } from "node:child_process";
import fs from "node:fs";
import { CodexInvocation, CodexRunResult } from "./types.js";

const MAX_OUTPUT_BYTES = 512 * 1024;
const MINIMAL_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
] as const;

function trimOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function extractTextFromJsonLines(stdout: string): string | undefined {
  const texts: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const type = String(payload.type ?? "");

      if (
        ["message", "final_answer", "agent_message", "output_text"].includes(type) &&
        typeof payload.text === "string"
      ) {
        texts.push(payload.text);
      }

      if (type === "turn_complete" && typeof payload.output === "string") {
        texts.push(payload.output);
      }
    } catch {
      // Human output is also valid; ignore non-JSON lines here.
    }
  }

  const joined = texts.join("\n").trim();
  return joined || undefined;
}

function isCodexFooterLine(line: string): boolean {
  return (
    line === "tokens used" ||
    /^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN)\b/.test(line) ||
    /^[\d,]+$/.test(line)
  );
}

function extractTextFromHumanTranscript(stdout: string): string | undefined {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  const lastCodexMarker = lines
    .map((line) => line.trim())
    .lastIndexOf("codex");

  if (lastCodexMarker < 0) {
    return undefined;
  }

  const answerLines: string[] = [];
  for (const line of lines.slice(lastCodexMarker + 1)) {
    const trimmed = line.trim();
    if (isCodexFooterLine(trimmed)) {
      break;
    }

    answerLines.push(line);
  }

  const answer = answerLines.join("\n").trim();
  return answer || undefined;
}

function normalizeCodexStdout(stdout: string): string {
  const jsonText = extractTextFromJsonLines(stdout);
  if (jsonText) {
    return jsonText;
  }

  const humanText = extractTextFromHumanTranscript(stdout);
  if (humanText) {
    return humanText;
  }

  return trimOutput(stdout);
}

export function buildChildEnv(invocation: {
  codexHome?: string | undefined;
  envMode: "inherit" | "minimal";
  envPassthrough: string[];
}): NodeJS.ProcessEnv {
  if (invocation.envMode === "inherit") {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (invocation.codexHome) {
      env.CODEX_HOME = invocation.codexHome;
    }
    return env;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const key of invocation.envPassthrough) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (invocation.codexHome) {
    env.CODEX_HOME = invocation.codexHome;
  }

  return env;
}

export async function runCodexInvocation(
  invocation: CodexInvocation,
): Promise<CodexRunResult> {
  if (!fs.existsSync(invocation.workspace)) {
    fs.mkdirSync(invocation.workspace, { recursive: true });
  }

  const args = [...invocation.args, invocation.prompt];

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, args, {
      cwd: invocation.workspace,
      env: buildChildEnv(invocation),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, invocation.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(-MAX_OUTPUT_BYTES);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(-MAX_OUTPUT_BYTES);
      }
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        text: normalizeCodexStdout(stdout),
        stderr: trimOutput(stderr),
        exitCode,
        timedOut,
      });
    });
  });
}
