import assert from "node:assert/strict";
import test from "node:test";
import { assertMappingCoversPorts } from "@hypit/generation";
import type { BlobRef, CanonicalValue } from "@hypit/protocol";
import { gptImage2Ports, sealGptImage2Request } from "@hypit/gpt-image";
import { grokImaginePorts, sealGrokImagineRequest } from "@hypit/grok-imagine";
import { minimaxH3Ports, sealMinimaxH3Request } from "@hypit/minimax-h3";
import { nanoBananaPorts } from "@hypit/nano-banana";
import { seedancePorts, sealSeedanceRequest } from "@hypit/seedance";
import { seedream5LitePorts, sealSeedreamRequest } from "@hypit/seedream";

import { openRouterMappings } from "../src/mapping.js";
import { openRouterRouteForCapability } from "../src/routes.js";

const image: BlobRef = { kind: "blob", resource: "res_openrouter_1", size: 3, mediaType: "image/png" };
const video: BlobRef = { kind: "blob", resource: "res_openrouter_2", size: 3, mediaType: "video/mp4" };
const resolve = async () => "https://example.test/reference";
const route = (module: string, name: string) => openRouterRouteForCapability({ module: { name: module, version: "1" }, name })!;
const constraints = (request: unknown) => request as CanonicalValue;

test("every OpenRouter mapping covers its model's ports", () => {
  const tables = {
    ...seedancePorts, ...grokImaginePorts, ...nanoBananaPorts,
    "seedream-5-lite": seedream5LitePorts, "minimax-h3": minimaxH3Ports, "gpt-image-2": gptImage2Ports,
  };
  for (const mapping of openRouterMappings) {
    assertMappingCoversPorts(tables[mapping.capability.name as keyof typeof tables], mapping);
  }
});

test("Seedance frames and references fold into OpenRouter video fields", async () => {
  const seedance = route("@hypit/seedance", "seedance-2.5");
  const framed = seedance.prepare(constraints(sealSeedanceRequest("seedance-2.5", {
    prompt: ["go"], resolution: ["720p"], duration: [5], generateAudio: [true], webSearch: [false],
    aspectRatio: ["16:9"],
    firstFrame: [{ role: "image", artifact: image, fields: { personReference: true } }],
  })));
  assert.equal(framed.model, "bytedance/seedance-2.5");
  assert.deepEqual(await framed.compile(resolve), {
    model: "bytedance/seedance-2.5",
    prompt: "go",
    duration: 5,
    resolution: "720p",
    aspect_ratio: "16:9",
    generate_audio: true,
    frame_images: [{ type: "image_url", image_url: { url: "https://example.test/reference" }, frame_type: "first_frame" }],
  });

  const referenced = seedance.prepare(constraints(sealSeedanceRequest("seedance-2.5", {
    prompt: ["go"], resolution: ["720p"], duration: [8], generateAudio: [false], webSearch: [false],
    aspectRatio: ["9:16"],
    referenceVideo: [{ role: "video", artifact: video, fields: { personReference: false } }],
  })));
  assert.deepEqual(await referenced.compile(resolve), {
    model: "bytedance/seedance-2.5",
    prompt: "go",
    duration: 8,
    resolution: "720p",
    aspect_ratio: "9:16",
    generate_audio: false,
    input_references: [{ type: "video_url", video_url: { url: "https://example.test/reference" } }],
  });
});

test("Seedance adaptive aspect ratio and web search are unsupported", () => {
  const mini = route("@hypit/seedance", "seedance-2-mini");
  const ports = {
    prompt: ["A handheld tracking shot through a crowded neon night market."],
    duration: [5], resolution: ["720p"], aspectRatio: ["adaptive"],
    generateAudio: [false], webSearch: [false],
  };
  assert.equal(mini.supports({
    capability: mini.capability, returns: mini.returns,
    constraints: constraints(sealSeedanceRequest("seedance-2-mini", ports)),
  }).status, "unsupported");

  const search = sealSeedanceRequest("seedance-2", {
    prompt: ["go"], duration: [5], resolution: ["720p"], aspectRatio: ["16:9"],
    generateAudio: [true], webSearch: [true],
  });
  assert.equal(route("@hypit/seedance", "seedance-2").supports({
    capability: route("@hypit/seedance", "seedance-2").capability,
    returns: route("@hypit/seedance", "seedance-2").returns,
    constraints: constraints(search),
  }).status, "unsupported");
});

test("Seedream quality becomes the OpenRouter resolution tier and 3K is unsupported", async () => {
  const seedream = route("@hypit/seedream", "seedream-5-lite");
  const request = sealSeedreamRequest({
    prompt: ["a cup"], aspectRatio: ["9:16"], quality: ["ultra"], outputFormat: ["png"], nsfwCheck: [true],
    images: [{ role: "image", artifact: image }],
  });
  assert.deepEqual(await seedream.prepare(constraints(request)).compile(resolve), {
    model: "bytedance-seed/seedream-5-0-lite",
    prompt: "a cup",
    aspect_ratio: "9:16",
    resolution: "4K",
    input_references: [{ type: "image_url", image_url: "https://example.test/reference" }],
  });
  const high = sealSeedreamRequest({ ...request.ports, quality: ["high"] });
  assert.equal(seedream.supports({
    capability: seedream.capability, returns: seedream.returns, constraints: constraints(high),
  }).status, "unsupported");
});

test("GPT Image 2 resolution outside 1K is unsupported before references resolve", () => {
  const gpt = route("@hypit/gpt-image", "gpt-image-2");
  const request = sealGptImage2Request({ prompt: ["cut"], aspectRatio: ["1:1"], resolution: ["2K"] });
  assert.equal(gpt.supports({
    capability: gpt.capability, returns: gpt.returns, constraints: constraints(request),
  }).status, "unsupported");
});

test("Grok Imagine 1.5 maps one image to first_frame and refuses a second", async () => {
  const grok = route("@hypit/grok-imagine", "grok-imagine-video-1.5-preview");
  const one = sealGrokImagineRequest("grok-imagine-video-1.5-preview", {
    prompt: ["turn"], aspectRatio: ["9:16"], resolution: ["720p"], duration: [6],
    images: [{ role: "image", artifact: image }],
  });
  assert.deepEqual(await grok.prepare(constraints(one)).compile(resolve), {
    model: "x-ai/grok-imagine-video-1.5",
    prompt: "turn",
    duration: 6,
    resolution: "720p",
    aspect_ratio: "9:16",
    frame_images: [{ type: "image_url", image_url: { url: "https://example.test/reference" }, frame_type: "first_frame" }],
  });
  const two = sealGrokImagineRequest("grok-imagine-video-1.5-preview", {
    prompt: ["turn"], aspectRatio: ["9:16"], resolution: ["720p"], duration: [6],
    images: [
      { role: "image", artifact: image },
      { role: "image", artifact: { ...image, resource: "res_openrouter_3" } },
    ],
  });
  assert.equal(grok.supports({
    capability: grok.capability, returns: grok.returns, constraints: constraints(two),
  }).status, "unsupported");
});

test("MiniMax H3 768P is unsupported", () => {
  const minimax = route("@hypit/minimax-h3", "minimax-h3");
  const request = sealMinimaxH3Request({
    prompt: ["a kite"], duration: [6], resolution: ["768P"], aspectRatio: ["16:9"],
  });
  assert.equal(minimax.supports({
    capability: minimax.capability, returns: minimax.returns, constraints: constraints(request),
  }).status, "unsupported");
});
