import { z } from "zod";
import type { ToolDefinition } from "./index.js";
import type { ProviderStatus } from "@myla/shared";

const SearchArgsSchema = z.object({
  query: z.string().min(1),
  count: z.number().min(1).max(10).default(5)
});

export function createSearchTools(): ToolDefinition[] {
  return [
    {
      name: "search.web",
      provider: "search",
      operation: "web search",
      description: "Search the web through Brave, Tavily, or SearxNG and return cited snippets.",
      requiredScopes: ["SEARCH_API_KEY or SEARXNG_URL"],
      riskLevel: "read",
      approvalMode: "auto",
      argsSchema: SearchArgsSchema,
      getProviderStatus: getSearchProviderStatus,
      dryRun: (args) => `Search the web for "${args.query}".`,
      execute: async (args) => runSearch(SearchArgsSchema.parse(args))
    }
  ];
}

function getSearchProviderStatus(): ProviderStatus {
  const configured = Boolean(process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY || process.env.SEARXNG_URL);
  return {
    provider: "search",
    status: configured ? "ready" : "needs_setup",
    message: configured
      ? "Search provider is configured."
      : "Configure BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL to enable web search.",
    requiredScopes: ["BRAVE_SEARCH_API_KEY or TAVILY_API_KEY or SEARXNG_URL"],
    missingConfig: configured ? [] : ["BRAVE_SEARCH_API_KEY or TAVILY_API_KEY or SEARXNG_URL"],
    tools: []
  };
}

async function runSearch(args: z.infer<typeof SearchArgsSchema>): Promise<unknown> {
  if (process.env.BRAVE_SEARCH_API_KEY) {
    return searchBrave(args);
  }

  if (process.env.TAVILY_API_KEY) {
    return searchTavily(args);
  }

  if (process.env.SEARXNG_URL) {
    return searchSearxng(args);
  }

  return {
    kind: "scaffold",
    provider: "search",
    message: "Configure BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL to enable web search."
  };
}

async function searchBrave(args: z.infer<typeof SearchArgsSchema>) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", String(args.count));

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY ?? ""
    }
  });

  if (!response.ok) {
    throw new Error(`Brave Search returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return {
    provider: "brave",
    results:
      payload.web?.results?.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.description
      })) ?? []
  };
}

async function searchTavily(args: z.infer<typeof SearchArgsSchema>) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query: args.query,
      max_results: args.count,
      search_depth: "basic"
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return {
    provider: "tavily",
    results:
      payload.results?.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content
      })) ?? []
  };
}

async function searchSearxng(args: z.infer<typeof SearchArgsSchema>) {
  const url = new URL(process.env.SEARXNG_URL ?? "");
  url.searchParams.set("q", args.query);
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SearxNG returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return {
    provider: "searxng",
    results:
      payload.results?.slice(0, args.count).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content
      })) ?? []
  };
}
