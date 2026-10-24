const OPENAI_MODERATION_TIMEOUT_MS = 8_000;

export type OpenAiModerationResult =
  | { outcome: "classified"; flagged: boolean; categorySummary: string }
  | { outcome: "empty_input" | "missing_decision" }
  | { outcome: "http_error"; status: number; requestId: string; detail: string };

export async function requestOpenAiModeration(
  apiKey: string,
  payload: { text: string; imageUrl?: string; clientRequestId?: string },
): Promise<OpenAiModerationResult> {
  const input = [
    payload.text ? { type: "text", text: payload.text } : null,
    payload.imageUrl ? { type: "image_url", image_url: { url: payload.imageUrl } } : null,
  ].filter(Boolean);

  if (input.length === 0) {
    return {
      outcome: "empty_input",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODERATION_TIMEOUT_MS);

  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(payload.clientRequestId ? { "X-Client-Request-Id": payload.clientRequestId } : {}),
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input,
    }),
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? "unknown";
    const responseText = await response.text().catch(() => "");
    const responseDetail = parseOpenAIErrorDetail(responseText);
    console.warn("OpenAI moderation request failed", {
      status: response.status,
      requestId,
      clientRequestId: payload.clientRequestId ?? null,
      detail: responseDetail,
    });
    return {
      outcome: "http_error",
      status: response.status,
      requestId,
      detail: responseDetail,
    };
  }

  const data = (await response.json()) as {
    results?: Array<{
      flagged?: boolean;
      categories?: Record<string, boolean>;
    }>;
  };

  const first = data.results?.[0];
  if (!first || typeof first.flagged !== "boolean") {
    return {
      outcome: "missing_decision",
    };
  }

  const flagged = Boolean(first?.flagged);
  const categories = first?.categories ?? {};
  const activeCategories = Object.entries(categories)
    .filter(([, active]) => Boolean(active))
    .map(([name]) => name)
    .join(", ");

  return {
    outcome: "classified",
    flagged,
    categorySummary: activeCategories || (flagged ? "flagged" : "clean"),
  };
}

function parseOpenAIErrorDetail(raw: string): string {
  if (!raw.trim()) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        code?: string;
        message?: string;
        type?: string;
      };
    };
    const parts = [parsed.error?.type, parsed.error?.code, parsed.error?.message].filter(
      (item): item is string => Boolean(item && item.trim().length > 0),
    );
    return parts.join(": ");
  } catch {
    return raw.slice(0, 240).replace(/\s+/g, " ").trim();
  }
}
