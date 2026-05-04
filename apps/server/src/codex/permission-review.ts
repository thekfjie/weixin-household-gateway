import { PermissionReviewConfig } from "../config/types.js";

interface PermissionReviewResult {
  allow: boolean;
  reason: string;
}

interface ReviewChatCompletionBody {
  output_text?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function buildReviewUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) {
    return baseUrl;
  }
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildPrompt(params: {
  toolKind: string;
  detail: string;
  contentText: string;
  touchedPaths: string[];
}): string {
  const lines = [
    "你是一个严格但务实的权限审核器。",
    "目标：判断这次 family 用户发起的工具权限请求是否可以放行。",
    "默认策略：宁可误拒绝，也不要放过高危请求。",
    "以下情况必须拒绝，不能因为“用户明确要求”就放行：提权、sudo、su、root、systemctl、service、journalctl、修改 systemd、修改 sudoers、卸载脚本、安装脚本、删除项目目录、删除数据目录、rm/rm -rf、curl|bash、wget|bash、软件包安装、网络横向访问、ssh/scp/rsync、docker、kubectl、挂载磁盘、重启关机，以及任何系统级管理操作。",
    "family 只应允许普通办公、附件处理、文档转换、表格/PPT/图片处理，以及当前会话工作区内的低风险读写执行。",
    "如果请求涉及工作区之外路径、系统目录、服务管理、账号权限、持久化删除、基础设施变更，一律拒绝。",
    "只返回一行 JSON，不要解释。",
    "格式：{\"allow\":true|false,\"reason\":\"简短中文原因\"}",
    "",
    `tool_kind=${params.toolKind}`,
    `detail=${params.detail}`,
    `paths=${params.touchedPaths.join(", ") || "(none)"}`,
    `content=${params.contentText || "(none)"}`,
  ];
  return lines.join("\n");
}

function parseReviewResponse(text: string): PermissionReviewResult | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.allow !== "boolean") {
      return undefined;
    }
    return {
      allow: parsed.allow,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : parsed.allow
            ? "小模型审核认为风险可接受"
            : "小模型审核认为存在明显风险",
    };
  } catch {
    return undefined;
  }
}

export async function reviewFamilyPermission(params: {
  config: PermissionReviewConfig | undefined;
  toolKind: string;
  detail: string;
  contentText: string;
  touchedPaths: string[];
}): Promise<PermissionReviewResult | undefined> {
  if (!params.config?.enabled) {
    return undefined;
  }

  const baseUrl = readOptionalEnv("CODEX_CLI_BASE_URL");
  const apiKey =
    readOptionalEnv("CODEX_CLI_API_KEY") ??
    readOptionalEnv("OPENAI_API_KEY") ??
    readOptionalEnv("CODEX_API_KEY");

  if (!baseUrl || !apiKey) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.config.timeoutMs);

  try {
    const response = await fetch(buildReviewUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.config.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "你只做 family 权限审核，不做任务执行。对高危操作采用拒绝优先。凡是提权、systemd/sudoers 变更、卸载/安装、删目录删数据、系统管理、工作区外高风险操作，一律拒绝，不得因用户要求而放行。",
          },
          {
            role: "user",
            content: buildPrompt(params),
          },
        ],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        allow: false,
        reason: `小模型审核失败：HTTP ${response.status}`,
      };
    }

    const parsedBody = (() => {
      try {
        return JSON.parse(text) as ReviewChatCompletionBody;
      } catch {
        return undefined;
      }
    })();

    const content =
      typeof parsedBody?.output_text === "string"
        ? parsedBody.output_text
        : typeof parsedBody?.choices?.[0]?.message?.content === "string"
          ? parsedBody.choices[0].message.content
          : typeof parsedBody?.choices?.[0]?.text === "string"
            ? parsedBody.choices[0].text
            : text;

    return parseReviewResponse(String(content).trim()) ?? {
      allow: false,
      reason: "小模型审核返回了无法识别的结果",
    };
  } catch (error) {
    return {
      allow: false,
      reason: `小模型审核异常：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
