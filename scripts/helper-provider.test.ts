/* eslint-disable @typescript-eslint/require-await -- Fake provider implements async fetch. */
/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
// Чат и помощник у разных провайдеров (HELPER_PROVIDER): каждый шаг уходит на адрес и с
// ключом своего провайдера, получает его правило рассуждения, а учёт подписывает строку им.
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { eveInternals, wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
process.env.MODEL_PROVIDER = "openrouter";
process.env.OPENROUTER_MODEL = "vendor/chat-fixture";
process.env.OPENROUTER_API_KEY = "chat-key";
process.env.OPENROUTER_CONTEXT_WINDOW = "9000";
process.env.HELPER_PROVIDER = "ollama";
process.env.HELPER_MODEL = "helper-fixture";
process.env.OLLAMA_API_KEY = "helper-key";
process.env.OLLAMA_BASE_URL = "https://helper.invalid/v1";
process.env.OLLAMA_CONTEXT_WINDOW = "8000";
process.env.THINKING_EFFORT = "high";
const home = await mkdtemp(join(tmpdir(), "iva-helper-provider-"));
process.env.ASSISTANT_DATA_DIR = home;
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
const { default: usageHook } = await import("../agent/hooks/usage.ts");
const { default: agent, stepModelChoice } = await import("../agent/agent.ts");
const { resolveRuntimeModelSelection } =
  await import("../node_modules/eve/dist/src/runtime/agent/resolve-model.js");

type Wire = {
  url: string;
  auth: string | null;
  model: string;
  effort?: string;
};

test("chat and helper reach their own providers with their own keys, effort and usage rows", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
    return rm(home, { recursive: true, force: true });
  });
  const wire: Wire[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init!.body as string) as {
      model: string;
      reasoning_effort?: string;
    };
    wire.push({
      url:
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      auth: new Headers(init?.headers).get("authorization"),
      model: body.model,
      effort: body.reasoning_effort,
    });
    const chunk = (delta: object, finish: string | null, usage?: object) => ({
      id: "answer",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const data = [
      chunk({ role: "assistant", content: "done" }, null),
      chunk({}, "stop", {
        prompt_tokens: 5,
        completion_tokens: 1,
        total_tokens: 6,
      }),
    ];
    return new Response(
      data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const eve = await eveInternals();
  async function run(kind: string) {
    return wireTurn({
      kind,
      onStep: async (ctx) => {
        const resolved = eve.buildResolveContext(ctx, []);
        const selection = await agent.model.events["step.started"]!(
          { type: "step.started", data: { stepIndex: 0 } },
          resolved,
        );
        const live = await resolveRuntimeModelSelection({
          selection,
          state: ctx,
          durability: "live",
        });
        ctx.setVirtualContext(eve.LiveStepDynamicModelSelectionKey, live);
      },
    });
  }
  const chat = await run("chat");
  const helper = await run("helper");
  const chatWire = wire.find((w) => w.model === "vendor/chat-fixture");
  const helperWire = wire.find((w) => w.model === "helper-fixture");
  assert.ok(chatWire && helperWire, JSON.stringify(wire));
  assert.match(chatWire.url, /^https:\/\/openrouter\.ai\/api\/v1\//);
  assert.equal(chatWire.auth, "Bearer chat-key");
  // OpenRouter reasoning_effort не понимает — как и без помощника.
  assert.equal(chatWire.effort, undefined);
  assert.match(helperWire.url, /^https:\/\/helper\.invalid\/v1\//);
  assert.equal(helperWire.auth, "Bearer helper-key");
  assert.equal(helperWire.effort, "high");
  assert.equal(
    chat.result.session.agent.modelReference?.contextWindowTokens,
    9000,
  );
  assert.equal(
    helper.result.session.agent.modelReference?.contextWindowTokens,
    8000,
  );

  const helperCtx = helper.authored.eve.buildResolveContext(helper.ctx, []);
  const choice = stepModelChoice(helperCtx);
  assert.equal(choice.provider, "ollama");
  // Пробник картинок знает только провайдера чата: OpenAI-совместимый помощник без картинок.
  assert.equal(await choice.seesImages(), false);

  await writeFile(join(home, "usage.jsonl"), "");
  for (const turn of [chat, helper]) {
    const ctx = turn.authored.eve.buildResolveContext(turn.ctx, []);
    await usageHook.events!["step.completed"]!(
      {
        data: {
          stepIndex: 0,
          turnId: ctx.session.id,
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      } as never,
      { ...ctx, channel: { kind: "http" } } as never,
    );
  }
  const rows = (await readFile(join(home, "usage.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { provider: string; model: string });
  assert.deepEqual(
    rows.map((row) => [row.provider, row.model]),
    [
      ["openrouter", "vendor/chat-fixture"],
      ["ollama", "helper-fixture"],
    ],
  );
});
