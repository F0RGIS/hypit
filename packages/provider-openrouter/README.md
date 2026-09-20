# `@hypit/provider-openrouter`

Hypit Runtime Provider for an [OpenRouter](https://openrouter.ai) account. Image capabilities call
`POST /api/v1/images` and store the returned files immediately. Video capabilities submit
`POST /api/v1/videos`, poll `GET /api/v1/videos/{jobId}` until the job is terminal, then download
`unsigned_urls` (or `GET /api/v1/videos/{jobId}/content`) into the current Build.

| Capability | OpenRouter model |
| --- | --- |
| `@hypit/seedance@1#seedance-2` | `bytedance/seedance-2.0` |
| `@hypit/seedance@1#seedance-2-fast` | `bytedance/seedance-2.0-fast` |
| `@hypit/seedance@1#seedance-2-mini` | `bytedance/seedance-2.0-mini` |
| `@hypit/seedance@1#seedance-2.5` | `bytedance/seedance-2.5` |
| `@hypit/seedream@1#seedream-5-lite` | `bytedance-seed/seedream-5-0-lite` |
| `@hypit/minimax-h3@1#minimax-h3` | `minimax/hailuo-3` |
| `@hypit/gpt-image@1#gpt-image-2` | `openai/gpt-image-2` |
| `@hypit/nano-banana@1#nano-banana-2` | `google/gemini-3.1-flash-image` |
| `@hypit/nano-banana@1#nano-banana-pro` | `google/gemini-3-pro-image` |
| `@hypit/grok-imagine@1#grok-imagine-video` | `x-ai/grok-imagine-video` |
| `@hypit/grok-imagine@1#grok-imagine-video-1.5-preview` | `x-ai/grok-imagine-video-1.5` |

OpenRouter's [image](https://openrouter.ai/api/v1/images/models) and
[video](https://openrouter.ai/api/v1/videos/models) indexes list further models; this Provider maps
only the models the Distribution already describes.

Video requests send `prompt`, `duration`, `resolution`, `aspect_ratio` and `generate_audio` where
the model declares them. First and last frames become `frame_images` with `frame_type`; reference
images, videos and audio become `input_references`. Grok Imagine with one image uses that image as
`first_frame`; several images travel as `input_references`. Seedance visual references require
`person-reference`; the Provider accepts the declaration and transmits nothing for it, since
OpenRouter has no field for it. `web-search="true"` is unsupported: the Videos API has no such field.

Image requests send `prompt`, `aspect_ratio`, `resolution` where the model takes it, GPT Image
`background`, and `input_references` for reference pictures. Seedream 5.0 lite maps `quality`
`basic`→`2K` and `ultra`→`4K`; `output-format` and `nsfw-check` have no OpenRouter field and are
not sent. Nano Banana `output-format` is likewise omitted.

Service limits this Provider reports as unsupported before submitting:

- Seedance aspect-ratio `adaptive` is unsupported. Seedance 2.5 renders 480p or 720p, not 1080p, and
  does not take duration `-1`. Seedance 2 Fast/Mini render 480p or 720p.
- Seedream 5.0 lite renders 2K (`quality="basic"`) or 4K (`quality="ultra"`); `high` (3K) is
  unsupported.
- `minimax/hailuo-3` renders 2K only, duration from 5 seconds, and accepts up to five reference
  images.
- GPT Image 2 has no resolution field on OpenRouter: only `1K` is accepted. `background` is `auto`
  or `opaque`; `transparent` is unsupported. Aspect ratios outside OpenRouter's GPT Image 2 list
  are refused.
- Nano Banana `aspect-ratio="auto"` is unsupported.
- Grok Imagine Video renders 480p or 720p for at most 15 seconds. Grok Imagine Video 1.5 also
  renders 1080p and animates at most one first-frame image. Aspect-ratio `auto` is unsupported.

Reference images and audio travel inline as `data:` URLs, within 30 MB per image and 15 MB per
audio file. A reference video must be a public HTTPS URL; configure `publicAssetUrl` when embedding
the Provider, otherwise such a request fails before submission.

Runtime Profile example:

```json
{
  "format": "hypit.runtime-local@1",
  "dataRoot": ".hypit/runtimes/local",
  "credentials": {
    "platform": {
      "use": "@hypit/credential-store-platform"
    }
  },
  "endpoints": {
    "openrouter.default": {
      "use": "@hypit/provider-openrouter",
      "pool": "openrouter.default",
      "config": {
        "apiKey": { "store": "platform", "key": "openrouter.api-key" },
        "defaultConcurrency": 3,
        "pollIntervalMs": 10000
      }
    }
  },
  "bindings": {}
}
```

`baseUrl` defaults to `https://openrouter.ai`. Store the API key with
`hypit auth login openrouter.default --runtime hypit.runtime.json`. Optional `requestTimeoutMs`,
`operationTimeoutMs` and `actionLimits` bound single HTTP calls, the whole remote video job and
action concurrency. HTTP failures keep OpenRouter's `error.code` and message; failed jobs keep the
job `error`, with any signed URL in the message redacted.
