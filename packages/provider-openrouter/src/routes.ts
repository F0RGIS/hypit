import {
  compileWireRequest,
  selectWireModelForRequest,
  generationTypes,
  sealGeneratedImageSet,
  sealGeneratedVideoSet,
} from "@hypit/generation";
import type { GenerationArtifactUrlResolver, GenerationRequest, GenerationWireMapping } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef, CapabilityRef, CanonicalValue, StoredValue, TypeRef } from "@hypit/protocol";
import type { EndpointRequest, EndpointSupport } from "@hypit/endpoint-kit";
import { openRouterMappings } from "./mapping.js";

/** Which OpenRouter generation API a capability submits through. */
export type OpenRouterProtocol = "image" | "video";

/** Documented byte limits for inline media; an absent kind is not accepted as a data URL. */
export type OpenRouterMediaLimits = {
  readonly image?: number;
  readonly audio?: number;
};

const MB = 1_000_000;

export const openRouterMediaLimits: Readonly<Record<OpenRouterProtocol, OpenRouterMediaLimits>> = {
  image: { image: 30 * MB },
  video: { image: 30 * MB, audio: 15 * MB },
};

export type OpenRouterPreparedRequest = {
  readonly model: string;
  readonly protocol: OpenRouterProtocol;
  readonly mediaLimits: OpenRouterMediaLimits;
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

export type OpenRouterRoute = GenerationWireMapping & {
  readonly key: string;
  readonly returns: TypeRef;
  readonly protocol: OpenRouterProtocol;
  readonly mediaLimits: OpenRouterMediaLimits;
  readonly supports: (request: EndpointRequest) => EndpointSupport;
  readonly prepare: (constraints: CanonicalValue) => OpenRouterPreparedRequest;
  readonly packageResult: (artifacts: readonly BlobRef[]) => StoredValue;
};

function scalar(request: GenerationRequest, port: string): string | number | boolean | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}
function count(request: GenerationRequest, port: string): number {
  return request.ports[port]?.length ?? 0;
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
function listed(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

const SEEDREAM_RESOLUTION: Readonly<Record<string, string>> = { basic: "2K", ultra: "4K" };
const SEEDANCE_20_RATIOS = ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"] as const;
const SEEDANCE_25_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const;
const GPT_IMAGE_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"] as const;
const NANO_BANANA_2_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"] as const;
const NANO_BANANA_PRO_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const GROK_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] as const;

/** OpenRouter's documented input ranges for each mapped model, checked before any reference is resolved. */
function rejection(mapping: GenerationWireMapping, request: GenerationRequest): string | undefined {
  const { name } = mapping.capability;
  const ratio = scalar(request, "aspectRatio");
  const resolution = scalar(request, "resolution");
  const duration = scalar(request, "duration");
  let model: string;
  try { model = selectWireModelForRequest(mapping, request); } catch (error) { return error instanceof Error ? error.message : String(error); }

  if (mapping.capability.module.name === "@hypit/seedance") {
    if (scalar(request, "webSearch") === true) {
      return `OpenRouter ${model} has no web_search field`;
    }
    if (name === "seedance-2.5") {
      if (duration === -1) return "OpenRouter bytedance/seedance-2.5 does not accept duration -1";
      if (resolution === "1080p") return "OpenRouter bytedance/seedance-2.5 renders 480p or 720p, not 1080p";
      if (!listed(ratio, SEEDANCE_25_RATIOS)) return `OpenRouter bytedance/seedance-2.5 does not render aspect-ratio ${String(ratio)}`;
    } else {
      if (name !== "seedance-2" && (resolution === "1080p" || resolution === "4k")) {
        return `OpenRouter ${model} renders 480p or 720p, not ${String(resolution)}`;
      }
      if (!listed(ratio, SEEDANCE_20_RATIOS)) return `OpenRouter ${model} does not render aspect-ratio ${String(ratio)}`;
    }
  }

  if (name === "seedream-5-lite" && SEEDREAM_RESOLUTION[String(scalar(request, "quality"))] === undefined) {
    return `OpenRouter Seedream 5.0 lite renders 2K (basic) or 4K (ultra), not quality ${String(scalar(request, "quality"))}`;
  }

  if (name === "minimax-h3") {
    if (resolution !== undefined && resolution !== "2K") return `OpenRouter minimax/hailuo-3 renders 2K only, not ${String(resolution)}`;
    if (typeof duration === "number" && duration < 5) return `OpenRouter minimax/hailuo-3 duration starts at 5 seconds, not ${String(duration)}`;
    if (count(request, "referenceImage") > 5) return "OpenRouter minimax/hailuo-3 accepts up to five reference images";
  }

  if (name === "gpt-image-2") {
    if (resolution !== "1K") return `OpenRouter openai/gpt-image-2 has no resolution field; it does not take ${String(resolution)}`;
    if (scalar(request, "background") === "transparent") return "OpenRouter openai/gpt-image-2 accepts background auto or opaque, not transparent";
    if (!listed(ratio, GPT_IMAGE_RATIOS)) return `OpenRouter openai/gpt-image-2 does not render aspect-ratio ${String(ratio)}`;
  }

  if (name === "nano-banana-2" && !listed(ratio, NANO_BANANA_2_RATIOS)) {
    return `OpenRouter google/gemini-3.1-flash-image does not render aspect-ratio ${String(ratio)}`;
  }
  if (name === "nano-banana-pro" && !listed(ratio, NANO_BANANA_PRO_RATIOS)) {
    return `OpenRouter google/gemini-3-pro-image does not render aspect-ratio ${String(ratio)}`;
  }

  if (mapping.capability.module.name === "@hypit/grok-imagine") {
    if (!listed(ratio, GROK_RATIOS)) return `OpenRouter ${model} does not render aspect-ratio ${String(ratio)}`;
    if (name === "grok-imagine-video") {
      if (resolution === "1080p") return "OpenRouter x-ai/grok-imagine-video renders 480p or 720p, not 1080p";
      if (typeof duration === "number" && duration > 15) return `OpenRouter x-ai/grok-imagine-video duration is at most 15 seconds, not ${String(duration)}`;
    }
    if (name === "grok-imagine-video-1.5-preview" && count(request, "images") > 1) {
      return "OpenRouter x-ai/grok-imagine-video-1.5 animates at most one first-frame image";
    }
  }
  return undefined;
}

function frameImage(url: string, frameType: "first_frame" | "last_frame") {
  return { type: "image_url", image_url: { url }, frame_type: frameType };
}
function videoRef(kind: "image" | "video" | "audio", url: string) {
  const type = `${kind}_url` as const;
  return { type, [type]: { url } };
}
function imageRef(url: string) {
  return { type: "image_url", image_url: url };
}

function videoBody(model: string, input: Record<string, unknown>, name: string): Record<string, unknown> {
  const frames = [
    ...(typeof input.first_frame === "string" ? [frameImage(input.first_frame, "first_frame")] : []),
    ...(typeof input.last_frame === "string" ? [frameImage(input.last_frame, "last_frame")] : []),
  ];
  const images = strings(input.images);
  const refs = [
    ...strings(input.reference_images).map((url) => videoRef("image", url)),
    ...strings(input.reference_videos).map((url) => videoRef("video", url)),
    ...strings(input.reference_audios).map((url) => videoRef("audio", url)),
  ];
  if (name.startsWith("grok-imagine")) {
    if (images.length === 1) frames.push(frameImage(images[0]!, "first_frame"));
    else refs.push(...images.map((url) => videoRef("image", url)));
  }
  const resolution = input.resolution === "4k" ? "4K" : input.resolution;
  return {
    model,
    prompt: input.prompt,
    ...(typeof input.duration === "number" ? { duration: input.duration } : {}),
    ...(typeof resolution === "string" ? { resolution } : {}),
    ...(typeof input.aspect_ratio === "string" ? { aspect_ratio: input.aspect_ratio } : {}),
    ...(typeof input.generate_audio === "boolean" ? { generate_audio: input.generate_audio } : {}),
    ...(frames.length > 0 ? { frame_images: frames } : {}),
    ...(refs.length > 0 ? { input_references: refs } : {}),
  };
}

function imageBody(model: string, input: Record<string, unknown>, name: string): Record<string, unknown> {
  const images = strings(input.images);
  const resolution = name === "seedream-5-lite"
    ? SEEDREAM_RESOLUTION[String(input.quality)]
    : name === "gpt-image-2" ? undefined : input.resolution;
  return {
    model,
    prompt: input.prompt,
    ...(typeof input.aspect_ratio === "string" ? { aspect_ratio: input.aspect_ratio } : {}),
    ...(typeof resolution === "string" ? { resolution } : {}),
    ...(name === "gpt-image-2" && typeof input.background === "string" ? { background: input.background } : {}),
    ...(images.length > 0 ? { input_references: images.map(imageRef) } : {}),
  };
}

function capabilityKey(capability: CapabilityRef): string {
  return `${capability.module.name}@${capability.module.version}#${capability.name}`;
}

export const openRouterRoutes: readonly OpenRouterRoute[] = openRouterMappings.map((mapping) => {
  const protocol: OpenRouterProtocol = mapping.result === "image" ? "image" : "video";
  const mediaLimits = openRouterMediaLimits[protocol];
  return {
    ...mapping,
    key: capabilityKey(mapping.capability),
    returns: mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,
    protocol,
    mediaLimits,
    supports: (request) => {
      const reason = rejection(mapping, request.constraints as unknown as GenerationRequest);
      return reason === undefined ? { status: "supported" } : { status: "unsupported", reason };
    },
    prepare: (constraints) => {
      const request = constraints as unknown as GenerationRequest;
      const reason = rejection(mapping, request);
      if (reason !== undefined) throw new Error(reason);
      const model = selectWireModelForRequest(mapping, request);
      return {
        model,
        protocol,
        mediaLimits,
        compile: async (resolve) => {
          const input = (await compileWireRequest(mapping, request, resolve)).input as Record<string, unknown>;
          return protocol === "image"
            ? imageBody(model, input, mapping.capability.name)
            : videoBody(model, input, mapping.capability.name);
        },
      };
    },
    packageResult: (artifacts) => ({
      kind: "inline",
      value: canonicalize(mapping.result === "image"
        ? sealGeneratedImageSet({ images: artifacts })
        : sealGeneratedVideoSet({ videos: artifacts })),
    }),
  };
});

const byCapability = new Map(openRouterRoutes.map((route) => [route.key, route]));

export function openRouterRouteForCapability(capability: CapabilityRef): OpenRouterRoute | undefined {
  return byCapability.get(capabilityKey(capability));
}
