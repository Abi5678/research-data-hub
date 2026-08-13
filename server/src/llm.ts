import { DataStore } from "./datastore.js";

const CLOUD_NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

export const cloudAllowed = process.env.ALLOW_CLOUD_NIM === "1";
const localBaseUrl = process.env.LLM_BASE_URL || "";

export function isAiAssistAvailable(): boolean {
  return cloudAllowed || localBaseUrl.length > 0;
}

export async function testLlmConnection(store: DataStore) {
  if (!isAiAssistAvailable()) {
    throw new Error(
      "AI assist is disabled. Set ALLOW_CLOUD_NIM=1 for cloud NIM or LLM_BASE_URL for a local endpoint.",
    );
  }

  const model = (await store.getSetting("nvidia_model")) || DEFAULT_MODEL;

  if (localBaseUrl) {
    const reply = await chatLocal(
      [{ role: "user", content: 'Reply with exactly the word "ok".' }],
      model,
      { maxTokens: 32, temperature: 0 },
    );
    return { model, reply: reply.trim().slice(0, 80), provider: "local" };
  }

  const apiKey = await store.getSetting("nvidia_api_key");
  if (!apiKey) throw new Error("No NVIDIA API key configured");
  const reply = await chatCloud(store, [{ role: "user", content: 'Reply with exactly the word "ok".' }], {
    maxTokens: 32,
    temperature: 0,
  });
  return { model, reply: reply.trim().slice(0, 80), provider: "cloud" };
}

async function chatLocal(
  messages: { role: string; content: string }[],
  model: string,
  opts: { maxTokens?: number; temperature?: number } = {},
) {
  const url = localBaseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 8192,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Local LLM error ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.length) {
    throw new Error("Local LLM returned an empty response");
  }
  return content;
}

async function getCloudConfig(store: DataStore) {
  if (!cloudAllowed) throw new Error("Cloud NIM is disabled (set ALLOW_CLOUD_NIM=1 to enable)");
  const apiKey = await store.getSetting("nvidia_api_key");
  const model = (await store.getSetting("nvidia_model")) || DEFAULT_MODEL;
  if (!apiKey) throw new Error("No NVIDIA API key configured");
  return { apiKey, model };
}

async function chatCloud(
  store: DataStore,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {},
) {
  const { apiKey, model } = await getCloudConfig(store);
  const res = await fetch(CLOUD_NIM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 8192,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NVIDIA API error ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.length) {
    throw new Error("NVIDIA API returned an empty response");
  }
  return content;
}

/** Free-form chat used by the Ask tab; routes to local endpoint or cloud NIM. */
export async function llmChat(
  store: DataStore,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  if (!isAiAssistAvailable()) {
    throw new Error(
      "AI assist is disabled. Set ALLOW_CLOUD_NIM=1 for cloud NIM or LLM_BASE_URL for a local endpoint.",
    );
  }
  if (localBaseUrl) {
    const model = (await store.getSetting("nvidia_model")) || DEFAULT_MODEL;
    return chatLocal(messages, model, opts);
  }
  return chatCloud(store, messages, opts);
}
