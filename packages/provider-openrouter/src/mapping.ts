import type { ModuleRef } from "@hypit/protocol";
import type { GenerationWireMapping } from "@hypit/generation";

const SEEDANCE: ModuleRef = { name: "@hypit/seedance", version: "1" };
const SEEDREAM: ModuleRef = { name: "@hypit/seedream", version: "1" };
const MINIMAX: ModuleRef = { name: "@hypit/minimax-h3", version: "1" };
const GPT_IMAGE: ModuleRef = { name: "@hypit/gpt-image", version: "1" };
const NANO_BANANA: ModuleRef = { name: "@hypit/nano-banana", version: "1" };
const GROK: ModuleRef = { name: "@hypit/grok-imagine", version: "1" };

/**
 * OpenRouter model IDs and the request fields they accept. Media fields keep intermediate names;
 * routes.ts folds them into `frame_images` / `input_references`. `personReference` is accepted on
 * Seedance visual references and not transmitted: OpenRouter has no field for it.
 */
const seedanceFields = {
  prompt: { as: "value", field: "prompt" },
  aspectRatio: { as: "value", field: "aspect_ratio" },
  duration: { as: "value", field: "duration" },
  resolution: { as: "value", field: "resolution" },
  firstFrame: { as: "url", field: "first_frame", resourceFields: ["personReference"] },
  lastFrame: { as: "url", field: "last_frame", resourceFields: ["personReference"] },
  referenceImage: { as: "urlArray", field: "reference_images", resourceFields: ["personReference"] },
  referenceVideo: { as: "urlArray", field: "reference_videos", resourceFields: ["personReference"] },
  referenceAudio: { as: "urlArray", field: "reference_audios" },
  generateAudio: { as: "value", field: "generate_audio" },
  webSearch: { as: "value", field: "web_search" },
} as const satisfies GenerationWireMapping["fields"];

const seedance = (name: string, model: string): GenerationWireMapping => ({
  capability: { module: SEEDANCE, name }, result: "video", routes: [{ model }], fields: seedanceFields,
});

export const openRouterMappings: readonly GenerationWireMapping[] = [
  seedance("seedance-2", "bytedance/seedance-2.0"),
  seedance("seedance-2-fast", "bytedance/seedance-2.0-fast"),
  seedance("seedance-2-mini", "bytedance/seedance-2.0-mini"),
  seedance("seedance-2.5", "bytedance/seedance-2.5"),
  {
    capability: { module: SEEDREAM, name: "seedream-5-lite" }, result: "image",
    routes: [{ model: "bytedance-seed/seedream-5-0-lite" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      quality: { as: "value", field: "quality" },
      outputFormat: { as: "value", field: "output_format" },
      nsfwCheck: { as: "value", field: "nsfw_check" },
      images: { as: "urlArray", field: "images" },
    },
  },
  {
    capability: { module: MINIMAX, name: "minimax-h3" }, result: "video",
    routes: [{ model: "minimax/hailuo-3" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      duration: { as: "value", field: "duration" },
      resolution: { as: "value", field: "resolution" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      firstFrame: { as: "url", field: "first_frame" },
      lastFrame: { as: "url", field: "last_frame" },
      referenceImage: { as: "urlArray", field: "reference_images" },
      referenceVideo: { as: "urlArray", field: "reference_videos" },
      referenceAudio: { as: "urlArray", field: "reference_audios" },
    },
  },
  {
    capability: { module: GPT_IMAGE, name: "gpt-image-2" }, result: "image",
    routes: [{ model: "openai/gpt-image-2" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      resolution: { as: "value", field: "resolution" },
      background: { as: "value", field: "background" },
      images: { as: "urlArray", field: "images" },
    },
  },
  ...([["nano-banana-2", "google/gemini-3.1-flash-image"], ["nano-banana-pro", "google/gemini-3-pro-image"]] as const)
    .map(([name, model]): GenerationWireMapping => ({
      capability: { module: NANO_BANANA, name }, result: "image", routes: [{ model }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        images: { as: "urlArray", field: "images" },
        aspectRatio: { as: "value", field: "aspect_ratio" },
        resolution: { as: "value", field: "resolution" },
        outputFormat: { as: "value", field: "output_format" },
      },
    })),
  {
    capability: { module: GROK, name: "grok-imagine-video" }, result: "video",
    routes: [{ model: "x-ai/grok-imagine-video" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      resolution: { as: "value", field: "resolution" },
      duration: { as: "value", field: "duration" },
      images: { as: "urlArray", field: "images" },
    },
  },
  {
    capability: { module: GROK, name: "grok-imagine-video-1.5-preview" }, result: "video",
    routes: [{ model: "x-ai/grok-imagine-video-1.5" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      resolution: { as: "value", field: "resolution" },
      duration: { as: "value", field: "duration" },
      images: { as: "urlArray", field: "images" },
    },
  },
];
