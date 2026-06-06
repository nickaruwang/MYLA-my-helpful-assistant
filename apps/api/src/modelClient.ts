import type { ModelRequest, ModelResponse } from "@jarvis/shared";

export async function callMlWorker(request: ModelRequest): Promise<ModelResponse> {
  const baseUrl = process.env.ML_WORKER_URL ?? "http://localhost:8001";

  try {
    const response = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`ML worker returned ${response.status}`);
    }

    return (await response.json()) as ModelResponse;
  } catch (error) {
    return {
      text: `Local ML worker is unavailable. Skeleton fallback response for: "${request.prompt}"`,
      model: "skeleton-fallback",
      route: "local",
      usage: {
        promptTokens: request.prompt.length,
        completionTokens: 0
      }
    };
  }
}
