/**
 * openclaw-sticky-context
 *
 * Persistent context slots that survive compaction. Injects content via
 * api.on("before_agent_start") → prependContext on every turn, so it
 * lives in the system prompt and never gets compacted away.
 *
 * Solves: https://github.com/openclaw/openclaw/issues/25947
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────

interface StickySlot {
  content: string;
  priority: number;
  pinned: boolean;
  created: string;
  updated: string;
}

interface StickyStore {
  version: 1;
  slots: Record<string, StickySlot>;
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveWorkspace(cfg: any): string {
  return (
    cfg?.agents?.defaults?.workspace ??
    cfg?.agent?.workspace ??
    join(process.env.HOME ?? "/root", ".openclaw", "workspace")
  );
}

function resolveStorePath(cfg: any): string {
  const pluginCfg = cfg?.plugins?.entries?.["sticky-context"]?.config ?? {};
  return join(resolveWorkspace(cfg), pluginCfg.file ?? "sticky-context.json");
}

function loadStore(path: string): StickyStore {
  if (!existsSync(path)) return { version: 1, slots: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { version: 1, slots: {} };
  }
}

function saveStore(path: string, store: StickyStore): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
}

function totalChars(store: StickyStore): number {
  return Object.values(store.slots).reduce(
    (sum, s: StickySlot) => sum + s.content.length,
    0,
  );
}

function slotCount(store: StickyStore): number {
  return Object.keys(store.slots).length;
}

function getConfig(cfg: any) {
  const c = cfg?.plugins?.entries?.["sticky-context"]?.config ?? {};
  return {
    maxTotalChars: c.maxTotalChars ?? 2000,
    maxSlots: c.maxSlots ?? 10,
    headerLabel: c.headerLabel ?? "STICKY CONTEXT (survives compaction)",
  };
}

function renderSlots(store: StickyStore, label: string): string {
  const entries = Object.entries(store.slots).sort((a, b) => {
    if (b[1].priority !== a[1].priority) return b[1].priority - a[1].priority;
    return a[0].localeCompare(b[0]);
  });
  if (entries.length === 0) return "";

  const lines: string[] = [
    `# ${label}`,
    "",
    "> These slots persist across compaction. Re-injected every turn.",
    "",
  ];
  for (const [key, slot] of entries) {
    const pin = slot.pinned ? " 📌" : "";
    lines.push(`## [${key}]${pin}`);
    lines.push(slot.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Plugin (object export, matches Cognee/community pattern) ─────────────

const stickyContextPlugin = {
  id: "sticky-context",
  name: "Sticky Context",

  register(api: any) {
    const logger = api.logger ?? console;
    const cfg = getConfig(api.config);

    // ── Inject on every turn via before_agent_start ──────────────────
    api.on("before_agent_start", async (_event: any, _ctx: any) => {
      try {
        const storePath = resolveStorePath(api.config);
        const store = loadStore(storePath);
        const content = renderSlots(store, cfg.headerLabel);
        if (!content) return {};
        return { prependContext: content };
      } catch (e) {
        logger.warn(`[sticky-context] Failed to inject: ${e}`);
        return {};
      }
    });

    // ── /sticky slash command (no LLM) ───────────────────────────────
    api.registerCommand({
      name: "sticky",
      description: "Show all sticky context slots",
      acceptsArgs: true,
      requireAuth: true,
      handler: (_ctx: any) => {
        const store = loadStore(resolveStorePath(api.config));
        const entries = Object.entries(store.slots).sort((a, b) => {
          if (b[1].priority !== a[1].priority)
            return b[1].priority - a[1].priority;
          return a[0].localeCompare(b[0]);
        });
        if (entries.length === 0) {
          return {
            text: "📌 No sticky context slots.\n\nUse sticky_set to create one.",
          };
        }
        const used = totalChars(store);
        const lines: string[] = [
          `📌 **Sticky Context** — ${entries.length}/${cfg.maxSlots} slots, ${used}/${cfg.maxTotalChars} chars (~${Math.round(used / 4)} tokens)`,
          "",
        ];
        for (const [key, slot] of entries) {
          const pin = (slot as StickySlot).pinned ? " 📌" : "";
          const prio =
            (slot as StickySlot).priority !== 0
              ? ` (priority: ${(slot as StickySlot).priority})`
              : "";
          const preview =
            (slot as StickySlot).content.length > 120
              ? (slot as StickySlot).content.slice(0, 120) + "…"
              : (slot as StickySlot).content;
          lines.push(
            `**${key}**${pin}${prio} — ${(slot as StickySlot).content.length} chars`,
          );
          lines.push(`> ${preview.replace(/\n/g, "\n> ")}`);
          lines.push("");
        }
        return { text: lines.join("\n") };
      },
    });

    // ── sticky_set ───────────────────────────────────────────────────
    api.registerTool({
      name: "sticky_set",
      description: [
        "Create or update a sticky context slot. Sticky slots survive",
        "compaction — content is injected into the system prompt every turn.",
        "Use for: safety constraints, active task state, critical instructions,",
        "identity anchors. Budget: ~500 tokens (~2000 chars) total.",
      ].join(" "),
      parameters: Type.Object({
        key: Type.String({
          description:
            "Slot name (lowercase, hyphens ok). e.g. safety-rules, active-task",
        }),
        content: Type.String({
          description: "Content to persist. Keep concise — eats budget every turn.",
        }),
        priority: Type.Optional(
          Type.Number({
            description:
              "Injection order (higher = first). Default 0. Use 100+ for safety.",
            default: 0,
          }),
        ),
        pinned: Type.Optional(
          Type.Boolean({
            description:
              "If true, only user can delete this slot. Default false.",
            default: false,
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const storePath = resolveStorePath(api.config);
        const store = loadStore(storePath);
        const key = params.key
          .toLowerCase()
          .replace(/[^a-z0-9-_]/g, "-")
          .slice(0, 64);

        const isNew = !(key in store.slots);
        const oldChars = isNew ? 0 : store.slots[key].content.length;
        const newChars = params.content.length;
        const currentTotal = totalChars(store);

        if (currentTotal + newChars - oldChars > cfg.maxTotalChars) {
          const available = cfg.maxTotalChars - currentTotal + oldChars;
          return {
            content: [
              {
                type: "text",
                text: `❌ Budget exceeded. ${newChars} chars but only ${available} available (${currentTotal}/${cfg.maxTotalChars} used).`,
              },
            ],
          };
        }
        if (isNew && slotCount(store) >= cfg.maxSlots) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Max slots reached (${cfg.maxSlots}).`,
              },
            ],
          };
        }

        const now = new Date().toISOString();
        store.slots[key] = {
          content: params.content,
          priority: params.priority ?? store.slots[key]?.priority ?? 0,
          pinned: params.pinned ?? store.slots[key]?.pinned ?? false,
          created: store.slots[key]?.created ?? now,
          updated: now,
        };
        saveStore(storePath, store);

        const total = totalChars(store);
        return {
          content: [
            {
              type: "text",
              text: `✅ ${isNew ? "Created" : "Updated"} sticky slot "${key}" (${newChars} chars). Budget: ${total}/${cfg.maxTotalChars} chars.`,
            },
          ],
        };
      },
    });

    // ── sticky_get ───────────────────────────────────────────────────
    api.registerTool({
      name: "sticky_get",
      description:
        "Read sticky context slots. With key: read one. Without: list all.",
      parameters: Type.Object({
        key: Type.Optional(
          Type.String({ description: "Slot name. Omit to list all." }),
        ),
      }),
      async execute(_id: string, params: any) {
        const store = loadStore(resolveStorePath(api.config));
        if (params.key) {
          const slot = store.slots[params.key];
          if (!slot) {
            return {
              content: [
                {
                  type: "text",
                  text: `Slot "${params.key}" not found. Available: ${Object.keys(store.slots).join(", ") || "(none)"}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ key: params.key, ...slot }, null, 2),
              },
            ],
          };
        }
        const entries = Object.entries(store.slots).sort(
          (a, b) =>
            b[1].priority - a[1].priority || a[0].localeCompare(b[0]),
        );
        const total = totalChars(store);
        const summary = entries.map(
          ([k, s]) =>
            `${k}${s.pinned ? " 📌" : ""} (${s.content.length} chars, priority ${s.priority})`,
        );
        return {
          content: [
            {
              type: "text",
              text: [
                `Slots: ${entries.length}/${cfg.maxSlots}`,
                `Budget: ${total}/${cfg.maxTotalChars} chars`,
                "",
                ...(summary.length ? summary : ["(none)"]),
              ].join("\n"),
            },
          ],
        };
      },
    });

    // ── sticky_delete ────────────────────────────────────────────────
    api.registerTool({
      name: "sticky_delete",
      description:
        "Delete a sticky context slot. Pinned slots can only be deleted by user.",
      parameters: Type.Object({
        key: Type.String({ description: "Slot name to delete" }),
      }),
      async execute(_id: string, params: any) {
        const storePath = resolveStorePath(api.config);
        const store = loadStore(storePath);
        const slot = store.slots[params.key];
        if (!slot) {
          return {
            content: [
              { type: "text", text: `Slot "${params.key}" not found.` },
            ],
          };
        }
        if (slot.pinned) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Slot "${params.key}" is pinned. Only user can delete.`,
              },
            ],
          };
        }
        delete store.slots[params.key];
        saveStore(storePath, store);
        return {
          content: [
            {
              type: "text",
              text: `✅ Deleted "${params.key}". Budget: ${totalChars(store)}/${cfg.maxTotalChars} chars.`,
            },
          ],
        };
      },
    });

    logger.info(
      `[sticky-context] Loaded. Budget: ${cfg.maxTotalChars} chars, max ${cfg.maxSlots} slots. Injecting via before_agent_start.`,
    );
  },
};

export default stickyContextPlugin;
