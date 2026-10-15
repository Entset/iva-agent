import { resolveContextWindow } from "./lib/context-window.ts";
import { claudeContextWindow } from "./lib/claude-cli.ts";
import { isHelperTurn, runsOnHelperModel } from "./lib/eve-auth.ts";
import { resolveHelperProvider } from "./lib/model-provider.ts";
import { defineAgent, defineDynamic } from "eve";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts
// и the selected helper model).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import {
  providerName,
  compatibleThinkingEffort,
  providerConfig as cfg,
  providerContextWindow,
  replaysReasoningOf,
  withReplayableReasoning,
  makeTextModel,
} from "./provider.js";
import { stepUsageLabel } from "./lib/usage-tap.js";
import { compactionThresholdPercent } from "./lib/compaction.js";
import { chatModelSeesImages } from "./vision.js";

export function stepModelChoice(
  ctx: Parameters<typeof isHelperTurn>[0] & { session: { id: string } },
) {
  // Помощник и виды хода из HELPER_RUNS идут на провайдере и модели помощника.
  const helper = runsOnHelperModel(ctx);
  // Модель и провайдер помощника разрешает resolveHelperProvider (HELPER_PROVIDER, HELPER_MODEL).
  // Читается на каждом шаге, как раньше HELPER_MODEL; неизвестное имя уже отбил старт provider.ts.
  const { name: provider, model } = helper
    ? resolveHelperProvider()
    : { name: providerName, model: cfg.textModel };
  const contextWindow =
    helper && provider === "claude"
      ? resolveContextWindow(
          "CLAUDE_CONTEXT_WINDOW",
          process.env.CLAUDE_CONTEXT_WINDOW,
          claudeContextWindow(model),
        )
      : providerContextWindow(provider);
  return Object.freeze({
    provider,
    model,
    contextWindow,
    // ponytail: пробник картинок знает только провайдера чата; у другого провайдера
    // помощника картинки видят лишь мультимодальные подписки codex и claude.
    seesImages: () =>
      provider === providerName
        ? chatModelSeesImages(model)
        : Promise.resolve(provider === "codex" || provider === "claude"),
    sessionId: ctx.session.id,
  });
}

export default defineAgent({
  // Модель строится на каждом шаге хода, а не при сборке: OpenCode Go требует ID диалога в
  // заголовке каждого запроса, а sessionId известен только здесь. Для остальных провайдеров
  // это та же модель, что раньше была статической (см. provider.ts, providerRequestHeaders).
  // step.started, не session.started: на self-host сессия — durable workflow, и выбор на
  // session.started eve сохраняет в журнал, а объект модели не сериализуется
  // (DynamicModelSelectionError). Шаговый резолвер живёт только в памяти. Модель та же на
  // каждом шаге, поэтому кэш промпта у провайдера не сбрасывается.
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => {
        const choice = stepModelChoice(ctx);
        return {
          model: withReplayableReasoning(
            makeTextModel({
              ...choice,
              chatModelSeesImages: choice.seesImages,
              usage: stepUsageLabel(event, choice.sessionId),
            }),
            replaysReasoningOf(choice.provider),
          ),
          modelContextWindowTokens: choice.contextWindow,
          modelCompactionThresholdPercent: compactionThresholdPercent(
            choice.contextWindow,
          ),
        };
      },
    },
  }),
  // eve maps this provider-agnostic setting to reasoning_effort for the
  // OpenAI-compatible Ollama Cloud and OpenCode Go endpoints.
  reasoning: compatibleThinkingEffort,
  // Окно контекста едет вместе с выбором модели выше (у динамической модели место ему
  // только там). ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос
  // переполнит окно до компактации.
  // Страховка от overflow внутри хода: eve сам пересказывает старые ходы перед шагом модели,
  // сохраняя todo и read-tracking. Обычный путь — свёртка между ходами на меньшем пороге
  // (agent/lib/compaction.ts, agent/lib/idle-compaction.ts).
  compaction: {
    thresholdPercent: compactionThresholdPercent(cfg.contextWindow),
  },
  // Сессия eve — durable workflow: каждый ход проигрывает весь журнал событий заново, и на
  // сутках активного чата реплей переваливает за потолок 240 с (vercel/workflow), ход
  // не стартует. Сутки от создания — штатный потолок eve: ход завершается, следующее
  // сообщение открывает свежую сессию. Память живёт в vault и это переживает; роллап
  // берёт на каждый день ночи свою сессию и снимает её после хода.
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1000 },
});
