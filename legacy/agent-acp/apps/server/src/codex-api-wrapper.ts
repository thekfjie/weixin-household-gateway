interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
  output_text?: string;
  error?: {
    message?: string;
  };
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`缺少环境变量：${name}`);
  }

  return value;
}

function readPrompt(argv: string[]): string {
  const prompt = argv[argv.length - 1]?.trim();
  if (!prompt) {
    throw new Error("缺少 prompt 参数。本 wrapper 需要把 prompt 放在最后一个参数。");
  }

  return prompt;
}

function buildUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) {
    return baseUrl;
  }

  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const isFamily = argv.includes("--family");
  const prompt = readPrompt(argv);
  const baseUrl = readEnv("CODEX_API_BASE_URL");
  const apiKey = readEnv("CODEX_API_KEY");
  const model = readEnv("CODEX_API_MODEL", "gpt-5.4");
  const timeoutMs = Number.parseInt(
    process.env.CODEX_API_TIMEOUT_MS ?? "180000",
    10,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: isFamily
              ? "你是家庭微信里的中文助手。只输出最终要发给用户的内容，不暴露命令、路径、内部配置或推理过程。"
              : "你是 admin 微信里的中文运维助手。只输出最终要发给用户的内容。",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new Error(`中转站返回的不是 JSON：${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      throw new Error(
        payload.error?.message ?? `中转站 HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const content =
      payload.output_text ??
      payload.choices?.[0]?.message?.content ??
      payload.choices?.[0]?.text ??
      "";
    if (!content.trim()) {
      throw new Error("中转站返回了空内容。");
    }

    console.log(content.trim());
  } finally {
    clearTimeout(timer);
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
