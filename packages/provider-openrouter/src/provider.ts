import { requestDeadline } from "@hypit/runtime-kit";
import type { AsyncEndpoint, EndpointCredential, EndpointInvocationContext, EndpointOutcome, ImmediateEndpointHandler } from "@hypit/endpoint-kit";
import { defineEndpointPackage, wakeAfter } from "@hypit/endpoint-kit";
import type { GenerationArtifactUrlResolver } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef, ResourceStore } from "@hypit/runtime";
import { openRouterRouteForCapability, openRouterRoutes } from "./routes.js";
import type { OpenRouterMediaLimits, OpenRouterRoute } from "./routes.js";
import { OpenRouterHttpError, OpenRouterServiceError, openRouterTaskFailure } from "./errors.js";

export const openRouterProviderModuleRef = { name: "@hypit/provider-openrouter", version: "1" } as const;

export type CreateOpenRouterProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly baseUrl?: string;
  readonly apiKey?: CredentialRef;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: import("@hypit/endpoint-kit").EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Publish a referenced Resource at a URL the service can fetch; replaces inline data URLs. */
  readonly publicAssetUrl?: (artifact: BlobRef, artifacts: ResourceStore, fields?: Readonly<Record<string, string | number | boolean>>) => Promise<string>;
};

type Handle = {
  readonly contract: "hypit.openrouter-operation@1";
  readonly taskId: string;
  readonly route: string;
  readonly startedAt: number;
  readonly urls?: readonly string[];
};

const OPENROUTER_HEADERS = {
  "http-referer": "https://hypit.ai",
  "x-title": "Hypit",
} as const;

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}
function apiBaseUrl(value: string): string {
  let trimmed = value.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  assert(trimmed.length > 0, "OpenRouter base URL is empty");
  return trimmed;
}
function apiKey(credentials: Readonly<Record<string, EndpointCredential>>): string {
  const value = credentials.apiKey?.secret;
  assert(typeof value === "string" && value.length > 0, "OpenRouter apiKey credential is unavailable; store an OpenRouter API key for this Endpoint");
  return value;
}
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(error: unknown): EndpointOutcome {
  return { status: "failed", failure: { code: error instanceof OpenRouterServiceError ? error.code : "OPENROUTER_ERROR", message: failureMessage(error) } };
}

class OpenRouterClient {
  constructor(readonly baseUrl: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch) {}
  private headers(key: string, extra?: HeadersInit): HeadersInit {
    return { authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS, ...(extra ?? {}) };
  }
  async json(path: string, key: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const deadline = requestDeadline(this.timeout);
    try {
      const response = await deadline.wait(this.fetcher(`${this.baseUrl}${path}`, {
        ...init, signal: deadline.signal, headers: this.headers(key, init.headers),
      }));
      const text = await deadline.wait(response.text());
      if (!response.ok) {
        const input = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        throw new OpenRouterHttpError(response.status, response, text, {
          method: init.method ?? "GET", path, ...(typeof input?.model === "string" ? { model: input.model } : {}),
        });
      }
      let body: unknown;
      try { body = text.length === 0 ? {} : JSON.parse(text); } catch { throw new Error(`OpenRouter returned invalid JSON (${response.status})`); }
      return object(body, "OpenRouter response");
    } finally { deadline.finish(); }
  }
  async download(url: string, key?: string): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    const deadline = requestDeadline(this.timeout);
    try {
      const headers = key === undefined ? undefined : this.headers(key);
      const response = await deadline.wait(this.fetcher(url, { signal: deadline.signal, ...(headers === undefined ? {} : { headers }) }));
      if (!response.ok) throw new Error(`OpenRouter asset returned HTTP ${response.status}`);
      return { bytes: new Uint8Array(await deadline.wait(response.arrayBuffer())), mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream" };
    } finally { deadline.finish(); }
  }
}

function mediaKind(mediaType: string): "image" | "video" | "audio" | undefined {
  const kind = mediaType.split("/", 1)[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : undefined;
}

function resolverFor(limits: OpenRouterMediaLimits, context: EndpointInvocationContext, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]): GenerationArtifactUrlResolver {
  const resolved = new Map<string, Promise<string>>();
  return (artifact, fields) => {
    const existing = resolved.get(artifact.resource);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      if (publicAssetUrl !== undefined) return await publicAssetUrl(artifact, context.resources, fields);
      const kind = mediaKind(artifact.mediaType);
      const limit = kind === undefined ? undefined : limits[kind as keyof OpenRouterMediaLimits];
      assert(limit !== undefined,
        `OpenRouter accepts ${artifact.mediaType} references only by public URL; configure publicAssetUrl for this Endpoint`);
      assert(artifact.size <= limit,
        `OpenRouter accepts ${kind} references up to ${limit / 1_000_000} MB for this model; ${artifact.resource} is ${artifact.size} bytes`);
      const bytes = await context.resources.get(artifact.resource);
      assert(bytes !== undefined && bytes.byteLength === artifact.size, `Reference Resource ${artifact.resource} is unavailable or has changed`);
      return `data:${artifact.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    })();
    resolved.set(artifact.resource, promise);
    return promise;
  };
}

async function prepare(context: EndpointInvocationContext, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]) {
  const route = openRouterRouteForCapability(context.need.capability);
  assert(route !== undefined, "OpenRouter does not implement this exact capability");
  const request = route.prepare(context.need.constraints);
  await context.reportProgress?.({ phase: `Preparing OpenRouter request: ${request.model}` });
  let body: Record<string, unknown>;
  try {
    body = await request.compile(resolverFor(request.mediaLimits, context, publicAssetUrl));
  } catch (error) {
    throw new OpenRouterServiceError(error instanceof OpenRouterServiceError ? error.code : "OPENROUTER_ERROR",
      `OpenRouter request preparation failed; model=${request.model}; generation not submitted: ${failureMessage(error)}`);
  }
  return { route, model: request.model, body };
}

function decodeDataUrl(value: string): { readonly bytes: Uint8Array; readonly mediaType: string } | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+=*)$/u.exec(value);
  if (match === null) return undefined;
  return { mediaType: match[1]!, bytes: Buffer.from(match[2]!, "base64") };
}

async function storeImages(
  client: OpenRouterClient,
  response: Record<string, unknown>,
  resources: ResourceStore,
  key: string,
): Promise<BlobRef[]> {
  assert(Array.isArray(response.data) && response.data.length > 0, "OpenRouter image response has no data");
  const blobs: BlobRef[] = [];
  for (const [index, item] of response.data.entries()) {
    const image = object(item, `OpenRouter image ${index + 1}`);
    const encoded = typeof image.b64_json === "string" ? image.b64_json : undefined;
    if (encoded !== undefined) {
      blobs.push(await resources.put(Buffer.from(encoded, "base64"), "image/png"));
      continue;
    }
    const url = typeof image.url === "string" ? image.url
      : typeof image.image_url === "string" ? image.image_url
      : typeof object(image.image_url ?? {}, `OpenRouter image ${index + 1} image_url`).url === "string"
        ? object(image.image_url, `OpenRouter image ${index + 1} image_url`).url as string
        : undefined;
    assert(typeof url === "string" && url.length > 0, `OpenRouter image ${index + 1} has no image data`);
    const inline = decodeDataUrl(url);
    if (inline !== undefined) {
      blobs.push(await resources.put(inline.bytes, inline.mediaType));
      continue;
    }
    const downloaded = await client.download(url, key);
    blobs.push(await resources.put(downloaded.bytes, downloaded.mediaType.startsWith("image/") ? downloaded.mediaType : "image/png"));
  }
  return blobs;
}

function videoUrls(client: OpenRouterClient, task: Record<string, unknown>, taskId: string): readonly string[] {
  if (Array.isArray(task.unsigned_urls) && task.unsigned_urls.length > 0) {
    return task.unsigned_urls.map((item, index) => {
      assert(typeof item === "string" && item.length > 0, `OpenRouter output ${index + 1} has no URL`);
      return item;
    });
  }
  return [`${client.baseUrl}/api/v1/videos/${encodeURIComponent(taskId)}/content`];
}

function endpoint(client: OpenRouterClient, pollIntervalMs: number, maxOperationMs: number, publicAssetUrl: CreateOpenRouterProviderOptions["publicAssetUrl"]): AsyncEndpoint {
  return {
    async start(context) {
      try {
        const { route, model, body } = await prepare(context, publicAssetUrl);
        assert(route.protocol === "video", "OpenRouter image capabilities use an immediate endpoint");
        await context.reportProgress?.({ phase: `Submitting OpenRouter request: ${model}` });
        const response = await client.json("/api/v1/videos", apiKey(context.credentials), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const taskId = response.id;
        assert(typeof taskId === "string" && taskId.length > 0, "OpenRouter response has no job id");
        const handle: Handle = { contract: "hypit.openrouter-operation@1", taskId, route: route.key, startedAt: Date.now() };
        const receipt = { id: handle.taskId };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "submitted" }), receipt };
      } catch (error) {
        return failure(error);
      }
    },
    async poll(context) {
      try {
        const handle = object(context.handle, "OpenRouter handle") as unknown as Handle;
        const route = openRouterRouteForCapability(context.need.capability);
        assert(route !== undefined && handle.contract === "hypit.openrouter-operation@1" && handle.route === route.key && route.protocol === "video", "OpenRouter handle is invalid");
        const receipt = { id: handle.taskId };
        if (Date.now() - handle.startedAt > maxOperationMs) {
          return { status: "failed", receipt, failure: { code: "OPENROUTER_OPERATION_TIMEOUT", message: `OpenRouter job ${handle.taskId} exceeded this Provider's operationTimeoutMs (${maxOperationMs}); remote outcome is unknown` } };
        }
        const task = await client.json(`/api/v1/videos/${encodeURIComponent(handle.taskId)}`, apiKey(context.credentials));
        const status = String(task.status);
        if (status === "pending" || status === "in_progress" || status === "queued" || status === "processing") {
          return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: status }), receipt };
        }
        const rejected = openRouterTaskFailure(task, handle.taskId);
        if (rejected !== undefined) return { ...failure(rejected), receipt };
        assert(status === "completed" || status === "succeeded", `OpenRouter returned unknown job status ${status}`);
        const urls = videoUrls(client, task, handle.taskId);
        return { status: "ready", handle: canonicalize({ ...handle, urls }), receipt };
      } catch (error) {
        return failure(error);
      }
    },
    async collect(context) {
      try {
        const handle = object(context.handle, "OpenRouter handle") as unknown as Handle;
        const route = openRouterRouteForCapability(context.need.capability);
        assert(route !== undefined && handle.route === route.key && Array.isArray(handle.urls), "OpenRouter collection route differs");
        await context.reportProgress?.({ phase: "Receiving generated files" });
        const key = apiKey(context.credentials);
        const blobs: BlobRef[] = [];
        for (const url of handle.urls) {
          const downloaded = await client.download(url, key);
          blobs.push(await resourcesPutVideo(context.resources, downloaded));
        }
        return { status: "completed", result: { value: route.packageResult(blobs) }, receipt: { id: handle.taskId } };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

async function resourcesPutVideo(resources: ResourceStore, downloaded: { readonly bytes: Uint8Array; readonly mediaType: string }): Promise<BlobRef> {
  const mediaType = downloaded.mediaType.startsWith("video/") ? downloaded.mediaType : "video/mp4";
  return await resources.put(downloaded.bytes, mediaType);
}

export function createOpenRouterProvider(options: CreateOpenRouterProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 30 * 60_000;
  for (const [name, value] of Object.entries({ requestTimeoutMs, operationTimeoutMs })) {
    assert(Number.isSafeInteger(value) && value > 0, `OpenRouter ${name} must be a positive integer`);
  }
  const client = new OpenRouterClient(apiBaseUrl(options.baseUrl ?? "https://openrouter.ai"), requestTimeoutMs, options.fetch ?? globalThis.fetch);
  const asyncEndpoint = endpoint(client, options.pollIntervalMs ?? 10_000, operationTimeoutMs, options.publicAssetUrl);
  const imageEndpoint: ImmediateEndpointHandler = async (context) => {
    const { route, model, body } = await prepare(context, options.publicAssetUrl);
    assert(route.protocol === "image", "OpenRouter video capabilities use an asynchronous endpoint");
    await context.reportProgress?.({ phase: `Submitting OpenRouter request: ${model}` });
    const key = apiKey(context.credentials);
    const response = await client.json("/api/v1/images", key, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    await context.reportProgress?.({ phase: "Receiving generated images" });
    return { value: route.packageResult(await storeImages(client, response, context.resources, key)) };
  };
  return defineEndpointPackage({
    module: openRouterProviderModuleRef, facet: "gateway", instance: options.instance ?? "openrouter.default", pool: options.pool ?? options.instance ?? "openrouter.default",
    pricing: { kind: "page", url: "https://openrouter.ai/models" },
    credentials: { apiKey: options.apiKey ?? credentialRef("os", "openrouter.api-key") },
    credentialInputs: { apiKey: { label: "OpenRouter API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 4,
    ...(options.actionLimits === undefined ? {} : { actionLimits: options.actionLimits }),
    capabilities: openRouterRoutes.map((route: OpenRouterRoute) => route.protocol === "image"
      ? { capability: route.capability, returns: route.returns, lifecycle: "immediate" as const, handler: imageEndpoint, capacity: route.capability.name, supports: route.supports }
      : { capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const, endpoint: asyncEndpoint, capacity: route.capability.name, supports: route.supports }),
  });
}
