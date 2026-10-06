import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationBlocks,
  elapsedLabel,
  turnPresentation,
} from "../src/lib/presentation";

test("explicit final answers remain visible while thought, commentary and tool history stay expandable", () => {
  const items = [
    { id: "user", type: "userMessage", turnId: "one" },
    { id: "thought", type: "reasoning", summary: ["公开摘要"] },
    {
      id: "progress",
      type: "agentMessage",
      phase: "commentary",
      text: "过程说明",
    },
    { id: "command", type: "commandExecution" },
    {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "最终结果",
    },
    { id: "compact", type: "contextCompaction" },
  ];
  const result = turnPresentation(items);
  assert.deepEqual(
    result.answers.map((item) => item.id),
    ["answer"],
  );
  assert.deepEqual(
    result.users.map((item) => item.id),
    ["user"],
  );
  assert.deepEqual(
    result.activity.map((item) => item.id),
    ["thought", "progress", "command"],
  );
  assert.deepEqual(
    result.dividers.map((item) => item.id),
    ["compact"],
  );
  assert.deepEqual(
    [...result.users, ...result.answers, ...result.activity, ...result.dividers]
      .map((item) => item.id)
      .sort(),
    items.map((item) => item.id).sort(),
  );
});

test("legacy unknown phases retain the last response; empty streaming answers do not add a second thinking indicator", () => {
  const result = turnPresentation([
    { id: "old", type: "agentMessage", text: "旧模型过程消息" },
    { id: "last", type: "agentMessage", text: "旧模型最终结果" },
  ]);
  assert.deepEqual(
    result.answers.map((item) => item.id),
    ["last"],
  );
  assert.deepEqual(
    result.activity.map((item) => item.id),
    ["old"],
  );
  assert.equal(
    turnPresentation([
      { id: "empty", type: "agentMessage", phase: "final_answer", text: "" },
    ]).answers.length,
    0,
  );
});

test("turn grouping keeps independent histories and unacknowledged user messages separate", () => {
  const metadata = [
    { id: "one", durationMs: 5000 },
    { id: "two", durationMs: 2000 },
  ];
  const blocks = conversationBlocks(
    [
      { id: "user-one", type: "userMessage", turnId: "one" },
      { id: "answer-one", type: "agentMessage", turnId: "one", text: "first" },
      { id: "user-two", type: "userMessage", turnId: "two" },
      { id: "answer-two", type: "agentMessage", turnId: "two", text: "second" },
      { id: "optimistic", type: "userMessage", status: "sending" },
    ],
    metadata,
  );
  assert.deepEqual(
    blocks.map((block) => block.id),
    ["one", "two", "optimistic"],
  );
  assert.equal(blocks[0]?.kind === "turn" && blocks[0].turn.durationMs, 5000);
  assert.equal(blocks[2]?.kind, "message");
});

test("elapsed time uses protocol duration or timestamps and never invents missing timing", () => {
  assert.equal(elapsedLabel({ durationMs: 1534000 }), "用时 25 分钟 34 秒");
  assert.equal(elapsedLabel({ startedAt: 100, completedAt: 101 }), "用时 1 秒");
  assert.equal(elapsedLabel({ durationMs: 60000 }), "用时 1 分钟");
  assert.equal(elapsedLabel({}), "工作过程");
  assert.equal(elapsedLabel({ startedAt: 200, completedAt: 100 }), "工作过程");
});

test("failed turns without items retain their error and chronological position", () => {
  const failed = {
    id: "failed",
    status: "failed",
    durationMs: null,
    error: { message: "账户不可用" },
    items: [],
  };
  const blocks = conversationBlocks(
    [{ id: "answer", type: "agentMessage", turnId: "next", text: "后来成功" }],
    [failed, { id: "next", status: "completed" }],
  );
  assert.deepEqual(
    blocks.map((block) => block.id),
    ["failed", "next"],
  );
  assert.equal(
    blocks[0]?.kind === "turn" && blocks[0].turn.error.message,
    "账户不可用",
  );
});
