const MAX_ERROR_DETAIL_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function describeJsonError(value: unknown): string | null {
  if (typeof value === "string") return value;

  const directMessage =
    stringField(value, "error") ??
    stringField(value, "message") ??
    stringField(value, "detail");
  if (directMessage) return directMessage;

  if (isRecord(value) && Array.isArray(value.errors)) {
    const messages = value.errors
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : stringField(entry, "message") ?? stringField(entry, "detail"),
      )
      .filter((message): message is string => Boolean(message));
    if (messages.length) return messages.join(", ");
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function limitDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_ERROR_DETAIL_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`;
}

export async function readHttpErrorDetail(
  response: Response,
): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const detail = describeJsonError((await response.json()) as unknown);
      return detail ? limitDetail(detail) : null;
    }

    const text = await response.text();
    return text.trim() ? limitDetail(text) : null;
  } catch {
    return null;
  }
}

export async function formatHttpError(
  prefix: string,
  response: Response,
): Promise<string> {
  const status = `${response.status}${
    response.statusText ? ` ${response.statusText}` : ""
  }`;
  const detail = await readHttpErrorDetail(response);
  return detail ? `${prefix}: ${status}: ${detail}` : `${prefix}: ${status}`;
}
