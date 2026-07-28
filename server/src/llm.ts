import { DataStore } from "./datastore.js";

const API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const DEFAULT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-instruct";

export async function testLlmConnection(store: DataStore) {
  const apiKey = await store.getSetting("nvidia_api_key");
  const model = (await store.getSetting("nvidia_model")) || DEFAULT_MODEL;
  if (!apiKey) throw new Error("No NVIDIA API key configured");
  const reply = await chat(store, [{ role: "user", content: 'Reply with exactly the word "ok".' }], {
    maxTokens: 32,
    temperature: 0,
  });
  return { model, reply: reply.trim().slice(0, 80) };
}

async function getConfig(store: DataStore) {
  const apiKey = await store.getSetting("nvidia_api_key");
  const model = (await store.getSetting("nvidia_model")) || DEFAULT_MODEL;
  if (!apiKey) throw new Error("No NVIDIA API key configured");
  return { apiKey, model };
}

async function chat(
  store: DataStore,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {},
) {
  const { apiKey, model } = await getConfig(store);
  const res = await fetch(API_URL, {
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
