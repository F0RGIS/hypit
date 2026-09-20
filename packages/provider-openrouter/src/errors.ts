/** OpenRouter's `{ error: { code, message } }` envelope and video-job `error` field, kept at the service boundary. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// Responses may mention a signed asset URL. Keep the reason, not its access capability.
export function safeOpenRouterReason(value: string): string {
  return value.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}

export class OpenRouterServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class OpenRouterHttpError extends OpenRouterServiceError {
  constructor(readonly status: number, response: { readonly headers: Headers }, bodyText: string,
    request: { readonly method: string; readonly path: string; readonly model?: string }) {
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(bodyText)); } catch { /* Non-JSON gateway failures still have HTTP evidence. */ }
    const error = record(body?.error);
    const code = text(error?.code) ?? text(error?.type) ?? text(body?.code) ?? "OPENROUTER_HTTP_ERROR";
    const reason = text(error?.message) ?? text(body?.error) ?? text(body?.message)
      ?? (body === undefined ? text(bodyText.slice(0, 2000)) : undefined);
    const requestId = text(response.headers.get("x-request-id")) ?? text(response.headers.get("x-openrouter-id"));
    const facts = [
      `OpenRouter HTTP ${status}`, code, `${request.method} ${request.path}`,
      ...(request.model === undefined ? [] : [`model=${request.model}`]),
      ...(requestId === undefined ? [] : [`request=${requestId}`]),
    ];
    super(code, `${facts.join("; ")}${reason === undefined ? "" : `: ${safeOpenRouterReason(reason)}`}`);
  }
}

/** A terminal video job; `undefined` otherwise. */
export function openRouterTaskFailure(task: Record<string, unknown>, id: string): OpenRouterServiceError | undefined {
  const status = String(task.status);
  if (!["failed", "cancelled", "canceled", "expired"].includes(status)) return undefined;
  const error = record(task.error);
  const code = text(error?.code) ?? text(error?.type) ?? "OPENROUTER_TASK_FAILED";
  const reason = text(error?.message) ?? text(task.error);
  return new OpenRouterServiceError(code,
    `OpenRouter job ${id} ${status}; ${code}${reason === undefined ? "" : `: ${safeOpenRouterReason(reason)}`}`);
}
