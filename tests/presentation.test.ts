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

test("compaction stays in its recorded position before later final answers, including the same turn", () => {
  const items = [
    { id: "first-final", type: "agentMessage", phase: "final_answer", text: "first" },
    { id: "compact", type: "contextCompaction" },
    { id: "second-final", type: "agentMessage", phase: "final_answer", text: "after compaction" },
    { id: "commentary", type: "agentMessage", phase: "commentary", text: "activity" },
  ];
  assert.deepEqual(turnPresentation(items).outputs.map((item) => item.id), ["first-final", "compact", "second-final"]);
  assert.deepEqual(turnPresentation(items).timelineBlocks.map(block => block.id), ['first-final', 'compact', 'second-final', 'commentary']);
});

test('open process history anchors compaction between earlier and continuing operations', () => {
  const result = turnPresentation([
    { id: 'before', type: 'commandExecution' },
    { id: 'compact', type: 'contextCompaction' },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'continuing' },
    { id: 'after', type: 'commandExecution' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'done' },
  ]);
  assert.deepEqual(result.timelineBlocks.map(block => block.id), ['activity:before', 'compact', 'progress', 'activity:after', 'final']);
  assert.equal(result.timelineBlocks.filter(block => block.id === 'compact').length, 1);
});

test("late compaction items follow canonical turn chronology instead of becoming a permanent history footer", () => {
  const blocks = conversationBlocks([
    { id: "first", type: "agentMessage", turnId: "one", text: "first answer" },
    { id: "next-user", type: "userMessage", turnId: "two" },
    { id: "next", type: "agentMessage", turnId: "two", text: "next answer" },
    { id: "compact", type: "contextCompaction", turnId: "compaction" },
  ], [{ id: "one", status: "completed" }, { id: "compaction", status: "completed" }, { id: "two", status: "completed" }]);
  assert.deepEqual(blocks.map((block) => block.id), ["one", "compaction", "two"]);
});

test('large shuffled canonical histories group once and preserve optimistic standalone anchors', () => {
  const turns = Array.from({ length: 10000 }, (_, index) => ({ id: `t${index}`, status: 'completed' }));
  const items = turns.slice().reverse().flatMap(turn => [{ id: `${turn.id}-user`, type: 'userMessage', turnId: turn.id }, { id: `${turn.id}-answer`, type: 'agentMessage', turnId: turn.id, text: 'answer' }]);
  items.splice(100, 0, { id: 'optimistic', type: 'userMessage', turnId: undefined } as any);
  const blocks = conversationBlocks(items, turns);
  assert.equal(blocks.length, 10001); assert.equal(blocks[50]!.id, 'optimistic');
  assert.deepEqual(blocks.filter(block => block.kind === 'turn').map(block => block.id), turns.map(turn => turn.id));
});
