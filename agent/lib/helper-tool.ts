import { existsSync } from "node:fs";
import { z } from "zod";
import { isHelperTurn } from "./eve-auth.ts";
import { traceHelper } from "./trace.ts";
import * as s from "./helper-store.ts";
import { readHelperOutcome } from "./helper-outcome.ts";
import { runHelperTick } from "./helper-tick.ts";
type Auth = {
  authenticator: string;
  principalType?: string;
  attributes?: Readonly<Record<string, unknown>> | null;
};
export type HelperToolContext = {
  session: {
    id: string;
    turn: { id: string };
    auth: { initiator?: Auth | null; current?: Auth | null };
  };
};
export const helperInputSchema = z.strictObject({
  action: z.enum(["start", "list", "close", "outcome", "revise"]),
  task: z.string().optional(),
  may: z.string().optional(),
  id: z.string().optional(),
});
// ponytail: round lives in the task prefix, no schema field; add `parent` to rows if chains need listing
export const HELPER_MAX_REVISIONS = 2;
export function revisionTask(row: s.HelperRow, fix: string) {
  const round = Number(/^Revision (\d+)/.exec(row.task)?.[1] ?? 0) + 1;
  if (round > HELPER_MAX_REVISIONS) return null;
  const path = s.helperResultPath(row.id);
  const original = row.task.split("\nOriginal task: ").pop()!;
  return `Revision ${round} of ${row.id}. Your previous result: ${existsSync(path) ? path : row.summary}
Fix only what Iva's review asks; keep what was right; return the full corrected result.
Corrections from Iva: ${fix.trim()}
Original task: ${original}`.slice(0, 2000);
}
export function helperAuth(ctx: {
  session?: Partial<Pick<HelperToolContext["session"], "auth">>;
}): s.HelperChat | null {
  const init = ctx?.session?.auth?.initiator,
    current = ctx?.session?.auth?.current;
  if (
    isHelperTurn(ctx) ||
    init?.authenticator !== "telegram-webhook" ||
    current?.authenticator !== "telegram-webhook" ||
    init.principalType !== "user" ||
    current.principalType !== "user" ||
    init.attributes?.chat_type !== "private" ||
    current.attributes?.chat_type !== "private" ||
    (current.attributes?.iva_turn !== undefined &&
      current.attributes.iva_turn !== "chat")
  )
    return null;
  const id = init.attributes.chat_id,
    threadId = init.attributes.message_thread_id;
  return typeof id === "string" && id.length > 0
    ? { id, threadId: typeof threadId === "string" ? threadId : null }
    : null;
}
export async function helperExecute(
  input: unknown,
  ctx: HelperToolContext,
  deps: {
    now?: number;
    tick?: typeof runHelperTick;
  } = {},
): Promise<string> {
  const chat = helperAuth(ctx);
  if (!chat) return "helper доступен только из личного хода владельца.";
  const parsed = helperInputSchema.safeParse(input);
  if (!parsed.success) return parsed.error.message;
  const v = parsed.data,
    now = deps.now ?? Date.now();
  try {
    if (v.action === "start") {
      if (v.may === undefined)
        return "Назови границы задания в may или передай пустую строку.";
      const r = await s.addHelper(
        { task: v.task ?? "", may: v.may, chat },
        now,
      );
      if (!r.ok) {
        traceHelper("refused", null, { data: { reason: r.reason } });
        return r.text;
      }
      void (deps.tick ?? runHelperTick)().catch(console.error);
      return `${r.row.id}. Allowed: ${r.row.may || "nothing, look and draft only"}. The helper works in the background. Answer the owner now that you handed the work off; do not answer for the helper. When it finishes you will get a system event.`;
    }
    if (v.action === "revise") {
      const prev = await s.showHelper(v.id ?? "", chat);
      if (!prev.ok) return prev.text;
      if (prev.row.outcome !== "done" && prev.row.outcome !== "empty")
        return "Доработка только по готовому исходу; неудачу повторяй с разрешения владельца.";
      if (!v.task?.trim()) return "Опиши корректировки в task.";
      const task = revisionTask(prev.row, v.task);
      if (!task)
        return `Лимит доработок (${HELPER_MAX_REVISIONS}) исчерпан. Расскажи владельцу исход как есть и свои замечания.`;
      const r = await s.addHelper({ task, may: prev.row.may, chat }, now);
      if (!r.ok) return r.text;
      void (deps.tick ?? runHelperTick)().catch(console.error);
      return `${r.row.id}: доработка ${prev.row.id} запущена с теми же границами. Коротко скажи владельцу, что проверила и что отправила на доработку.`;
    }
    if (v.action === "list")
      return JSON.stringify(
        (await s.listHelpers(chat)).map((r) => ({
          id: r.id,
          task: r.task.slice(0, 200),
          state: r.run
            ? "работает"
            : r.status === "pending"
              ? "ждёт"
              : r.status === "closed"
                ? "закрыто"
                : "готово",
          outcome: r.outcome,
          delivered: r.deliveredAt !== null,
        })),
      );
    if (v.action === "close") {
      const r = await s.closeHelper(v.id ?? "", chat, now);
      if (!r.ok) return r.text;
      void (deps.tick ?? runHelperTick)().catch(console.error);
      if (r.branch === "running" && r.row.stop !== "closed")
        return "Уже останавливается, исход придёт сам.";
      return r.branch === "pending"
        ? "Задание закрыто до запуска. Исход доступен через outcome."
        : r.branch === "running"
          ? "Останавливается, частичный итог будет после остановки; прочитай через outcome."
          : "Закрыто, автоматический пересказ снят; исход доступен через outcome.";
    }
    return await readHelperOutcome(v.id ?? "", chat, {
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
    });
  } catch (error) {
    if (error instanceof s.HelperStoreError)
      return "таблица помощников повреждена, помощники не работают";
    return `Не записалось, повтори: ${String(error)}`;
  }
}
