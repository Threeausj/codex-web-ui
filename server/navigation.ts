import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { Bridge } from "./bridge.js";

const cursor = z.string().max(8192).nullable().optional();
const threadId = z.string().min(1).max(256);
const paging = {
  cursor,
  limit: z.number().int().min(1).max(100).optional(),
  sortKey: z.enum(["created_at", "updated_at", "recency_at"]).optional(),
  archived: z.boolean().optional(),
};
const request = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("thread/list"),
      params: z
        .object({
          ...paging,
          modelProviders: z.array(z.string().max(256)).max(20).optional(),
          cwd: z.array(z.string().min(1).max(4096)).max(12).optional(),
          searchTerm: z.string().max(1000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/search"),
      params: z
        .object({ ...paging, searchTerm: z.string().min(1).max(1000) })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/read"),
      params: z.object({ threadId, includeTurns: z.literal(false) }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/turns/list"),
      params: z
        .object({
          threadId,
          cursor,
          limit: z.number().int().min(1).max(100).optional(),
          sortDirection: z.literal("desc"),
          itemsView: z.enum(["notLoaded", "summary", "full"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/archive"),
      params: z.object({ threadId }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/unarchive"),
      params: z.object({ threadId }).strict(),
    })
    .strict(),
]);

/** Sidebar operations use the selected host's official app-server bridge without
 * replacing the browser's active chat connection. Registered after auth/CSRF. */
export function registerNavigation(
  app: Express,
  getBridge: (hostId: string) => Promise<Bridge>,
) {
  const handler: RequestHandler = (req, res, next) => {
    void (async () => {
      const { method, params } = request.parse(req.body);
      const bridge = await getBridge(String(req.params.hostId));
      const result = await bridge.request(method, params);
      res.json(result);
    })().catch(next);
  };
  app.post("/api/navigation/:hostId", handler);
}
