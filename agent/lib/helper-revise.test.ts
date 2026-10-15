/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { revisionTask, HELPER_MAX_REVISIONS } from "./helper-tool.ts";
import type { HelperRow } from "./helper-store.ts";

test("revise counts rounds, keeps the original task and stops at the cap", () => {
  const row = {
    id: "h-abcdef",
    task: "Find invoices for May",
    summary: "s",
  } as HelperRow;
  let task = revisionTask(row, "June is missing")!;
  assert.match(task, /^Revision 1 of h-abcdef/);
  assert.match(
    task,
    /Corrections from Iva: June is missing\nOriginal task: Find invoices for May$/,
  );
  for (let i = 2; i <= HELPER_MAX_REVISIONS; i++) {
    task = revisionTask({ ...row, task }, "again")!;
    assert.match(task, new RegExp(`^Revision ${i} of`));
    assert.match(task, /Original task: Find invoices for May$/);
  }
  assert.equal(revisionTask({ ...row, task }, "more"), null);
});
