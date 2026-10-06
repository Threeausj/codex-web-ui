import type { Express } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writePrivateJson } from "./storage.js";

const id = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\x00-\x1f]/.test(value));
const safeKey = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
const profile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: z.string().trim().min(1).max(60),
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
    networkAccess: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.sandboxMode !== "danger-full-access" || value.networkAccess,
    "Full access cannot restrict networking",
  );
export const preferencesPatch = z
  .object({
    pins: z
      .array(
        z
          .object({
            kind: z.enum(["project", "thread"]),
            hostId: id,
            id,
            label: z.string().max(256).optional(),
          })
          .strict(),
      )
      .max(300)
      .optional(),
    collapsed: z
      .unknown()
      .superRefine((value, context) => {
        if (
          value &&
          typeof value === "object" &&
          Object.keys(value).some((key) =>
            ["__proto__", "constructor", "prototype"].includes(key),
          )
        )
          context.addIssue({
            code: "custom",
            message: "Unsafe preference key",
          });
      })
      .pipe(z.record(safeKey, z.boolean()))
      .optional(),
    permissionProfiles: z
      .array(profile)
      .max(30)
      .refine(
        (profiles) =>
          new Set(profiles.map((p) => p.id)).size === profiles.length,
        "Profile ids must be unique",
      )
      .optional(),
    activePermissionProfileId: z.string().max(100).optional(),
    defaultPermission: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.collapsed || Object.keys(value.collapsed).length <= 1000,
    "Too many collapsed sections",
  );
export type WebPreferences = z.infer<typeof preferencesPatch>;
export const emptyPreferences = () =>
  ({
    pins: [],
    collapsed: {},
    permissionProfiles: [],
    activePermissionProfileId: "",
    defaultPermission: "workspace-write",
  }) as Required<WebPreferences>;

export class Preferences {
  private value = emptyPreferences();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}
  async init() {
    try {
      this.value = {
        ...emptyPreferences(),
        ...preferencesPatch.parse(
          JSON.parse(await fs.readFile(this.file, "utf8")),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  get() {
    return structuredClone(this.value);
  }
  update(input: unknown) {
    const patch = preferencesPatch.parse(input);
    const operation = this.queue.then(async () => {
      const next = {
        ...this.value,
        ...patch,
        collapsed: patch.collapsed
          ? { ...this.value.collapsed, ...patch.collapsed }
          : this.value.collapsed,
      };
      if (patch.pins)
        next.pins = patch.pins.filter(
          (pin, index, pins) =>
            pins.findIndex(
              (other) =>
                other.kind === pin.kind &&
                other.hostId === pin.hostId &&
                other.id === pin.id,
            ) === index,
        );
      await writePrivateJson(this.file, next);
      this.value = next;
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
export async function registerPreferences(app: Express, dataDir: string) {
  const preferences = new Preferences(path.join(dataDir, "preferences.json"));
  await preferences.init();
  app.get("/api/preferences", (_req, res) =>
    res.json({ preferences: preferences.get() }),
  );
  app.patch("/api/preferences", (req, res, next) => {
    void preferences
      .update(req.body)
      .then((value) => res.json({ preferences: value }))
      .catch(next);
  });
  return preferences;
}
