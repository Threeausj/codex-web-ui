import test from "node:test";
import assert from "node:assert/strict";
import {
  exportThreadMarkdown,
  matchesProject,
  togglePin,
  sortedThreads,
  threadActivityAt,
  historyActivityAt,
} from "../src/lib/navigation";

test("project groups match exact roots without swallowing similarly named repositories", () => {
  const project = {
    path: "/projects/app",
    rootPaths: ["/projects/app", "/projects/shared"],
  };
  assert.equal(matchesProject({ cwd: "/projects/app" }, project), true);
  assert.equal(matchesProject({ cwd: "/projects/shared/" }, project), true);
  assert.equal(
    matchesProject({ cwd: "/projects/application" }, project),
    false,
  );
});
test("project and thread pins remain distinct and are scoped to the host", () => {
  const project = { kind: "project" as const, hostId: "local", id: "/project" };
  let pins = togglePin([], project);
  pins = togglePin(pins, { kind: "thread", hostId: "local", id: "/project" });
  pins = togglePin(pins, { ...project, hostId: "ssh-other" });
  pins = togglePin(pins, project);
  assert.equal(pins.length, 2);
  assert.equal(pins[0].kind, "thread");
  assert.equal(pins[1].hostId, "ssh-other");
});
test("recent history is sorted without changing source project lists", () => {
  const source = [
    { id: "first", recencyAt: 1, updatedAt: 100 },
    { id: "new", recencyAt: 3 },
    { id: "middle", createdAt: 2 },
  ];
  assert.deepEqual(
    sortedThreads(source).map((thread) => thread.id),
    ["new", "middle", "first"],
  );
  assert.equal(source[0].id, "first");
});
test("metadata changes and empty resumes do not count as conversation activity", () => {
  const empty = { createdAt: 20, updatedAt: 999, recencyAt: null };
  assert.equal(threadActivityAt(empty), 20);
  assert.equal(historyActivityAt(empty, []), 20);
  assert.equal(historyActivityAt(empty, [], 30), 30);
  assert.equal(
    historyActivityAt(empty, [{ startedAt: 40, completedAt: 42 }]),
    42,
  );
  assert.equal(
    historyActivityAt({ ...empty, recencyAt: 35 }, [{ completedAt: 42 }]),
    35,
  );
  assert.equal(threadActivityAt({ createdAt: 1, recencyAt: 1791200000000 }), 1791200000);
});
test("markdown export includes full messages, images, commands and file changes", () => {
  const text = exportThreadMarkdown(
    { id: "a", name: "Conversation", cwd: "/project" },
    [
      {
        items: [
          {
            type: "userMessage",
            content: [
              { type: "text", text: "Question" },
              { type: "localImage", path: "/image.png" },
            ],
          },
          { type: "agentMessage", text: "Answer" },
          {
            type: "commandExecution",
            command: "echo ok",
            aggregatedOutput: "ok",
          },
          {
            type: "fileChange",
            changes: [{ path: "/file", diff: "-old\n+new" }],
          },
        ],
      },
    ],
  );
  for (const part of [
    "# Conversation",
    "Question",
    "/image.png",
    "Answer",
    "echo ok",
    "-old\n+new",
  ])
    assert.ok(text.includes(part));
});
