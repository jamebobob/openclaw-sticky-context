/**
 * openclaw-sticky-context v2
 *
 * Persistent context slots that survive compaction. Injects content via
 * api.on("before_prompt_build") → appendSystemContext on every turn, so it
 * lives in the system prompt and never gets compacted away.
 *
 * Features:
 * - Slots persist in a JSON file, injected into system prompt every turn
 * - Pinned slots cannot be modified or deleted by the agent
 * - Sensitive slots are redacted before injection (IPs, tokens, secrets)
 * - Atomic file writes prevent corruption on crash
 * - One-way ratchet: agent can escalate pinned/sensitive but never downgrade
 *
 * Solves: https://github.com/openclaw/openclaw/issues/25947
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { join, dirname } from "path";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────

interface StickySlot {
  content: string;
  priority: number;
  pinned: boolean;
  sensitive: boolean;
  created: string;
  updated: string;
}

interface StickyStore {
  version: 1;
  slots: Record<string, StickySlot>;
}

interface RedactPatternDef {
  source: string;
  flags: string;
  label: string;
}

interface PluginConfig {
  maxTotalChars: number;
  maxSlots: number;
  headerLabel: string;
  redactPatterns: RedactPatternDef[];
}

// ── Redaction ────────────────────────────────────────────────────────
// Each call to redact() creates fresh RegExp instances from stored
// source/flags, avoiding shared lastIndex state across calls.

function builtinPatterns(): RedactPatternDef[] {
  return [
    // IPv4 addresses — require 0-255 per octet
    {
      source:
        "\\b(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b",
      flags: "g",
      label: "[IP]",
    },
    // IPv6 addresses (full form, 8 groups of hex)
    {
      source: "\\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}\\b",
      flags: "g",
      label: "[IP]",
    },
    // Host:port — require protocol prefix or @ to avoid matching file:line
    {
      source: "(?<=://|@)[\\w.-]+:\\d{2,5}\\b",
      flags: "g",
      label: "[HOST:PORT]",
    },
    // SSH connection strings — non-greedy, stop at whitespace or end
    {
      source: "\\bssh\\s+\\S+@\\S+?(?=\\s|$)",
      flags: "gi",
      label: "[SSH]",
    },
    // Common secret env patterns (KEY=value, SECRET: value, etc.)
    {
      source:
        "\\b(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)\\s*[=:]\\s*\\S+",
      flags: "gi",
      label: "[SECRET]",
    },
    // Prefixed API tokens (sk-, ghp_, gho_, vapi_, Bearer, etc.)
    {
      source: "\\b(?:sk-|ghp_|gho_|vapi_|Bearer\\s+)[A-Za-z0-9_-]+",
      flags: "g",
      label: "[TOKEN]",
    },
  ];
}

function parseCustomPatterns(raw: string[], logger: any): RedactPatternDef[] {
  const patterns: RedactPatternDef[] = [];
  for (const p of raw) {
    const sep = p.indexOf("||");
    const source = sep === -1 ? p : p.slice(0, sep);
    const label = sep === -1 ? "[REDACTED]" : p.slice(sep + 2) || "[REDACTED]";
    try {
      // Validate by constructing — throws on bad regex
      new RegExp(source, "g");
      patterns.push({ source, flags: "g", label });
    } catch (e) {
      logger.warn(`[sticky-context] Invalid redact pattern "${p}": ${e}`);
    }
  }
  return patterns;
}

function redact(content: string, patterns: RedactPatternDef[]): string {
  let result = content;
  for (const { source, flags, label } of patterns) {
    result = result.replace(new RegExp(source, flags), label);
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveWorkspace(cfg: any): string {
  return (
    cfg?.agents?.defaults?.workspace ??
    join(process.env.HOME ?? "/root", ".openclaw", "workspace")
  );
}

function resolveStorePath(cfg: any): string {
  const pluginCfg = cfg?.plugins?.entries?.["sticky-context"]?.config ?? {};
  return join(resolveWorkspace(cfg), pluginCfg.file ?? "sticky-context.json");
}

/**
 * Load the store from disk. Returns null on corruption or read failure.
 * Callers must handle null gracefully — either skip (hook) or report
 * an actionable error (tools/commands).
 */
function loadStore(path: string, logger: any): StickyStore | null {
  if (!existsSync(path)) return { version: 1, slots: {} };
  try {
    const store: StickyStore = JSON.parse(readFileSync(path, "utf-8"));
    // Backfill sensitive field for pre-v2 stores
    for (const slot of Object.values(store.slots)) {
      if (slot.sensitive === undefined) slot.sensitive = false;
    }
    return store;
  } catch (e) {
    logger.error(
      `[sticky-context] CORRUPT store at ${path}: ${e}. ` +
        `Sticky context will not be injected until the file is fixed or deleted.`,
    );
    return null;
  }
}

function atomicSave(path: string, store: StickyStore): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, path);
}

function totalChars(store: StickyStore): number {
  return Object.values(store.slots).reduce(
    (sum, s) => sum + s.content.length,
    0,
  );
}

function sortedEntries(store: StickyStore): [string, StickySlot][] {
  return Object.entries(store.slots).sort((a, b) => {
    if (b[1].priority !== a[1].priority) return b[1].priority - a[1].priority;
    return a[0].localeCompare(b[0]);
  });
}

function sanitizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 64);
}

function slotFlags(slot: StickySlot): string {
  return (slot.pinned ? " 📌" : "") + (slot.sensitive ? " 🔒" : "");
}

function getConfig(cfg: any, logger: any): PluginConfig {
  const c = cfg?.plugins?.entries?.["sticky-context"]?.config ?? {};
  const custom = Array.isArray(c.redactPatterns)
    ? parseCustomPatterns(c.redactPatterns, logger)
    : [];
  return {
    maxTotalChars: c.maxTotalChars ?? 2000,
    maxSlots: c.maxSlots ?? 10,
    headerLabel: c.headerLabel ?? "STICKY CONTEXT (survives compaction)",
    redactPatterns: [...builtinPatterns(), ...custom],
  };
}

function renderSlots(store: StickyStore, cfg: PluginConfig): string {
  const entries = sortedEntries(store);
  if (entries.length === 0) return "";

  const lines: string[] = [
    `# ${cfg.headerLabel}`,
    "",
    "> These slots persist across compaction. Re-injected every turn.",
    "",
  ];
  for (const [key, slot] of entries) {
    const pin = slot.pinned ? " 📌" : "";
    const content = slot.sensitive
      ? redact(slot.content, cfg.redactPatterns)
      : slot.content;
    lines.push(`## [${key}]${pin}`);
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n");
}

/** Standard error response for corrupt store, used by tools and commands. */
const CORRUPT_STORE_MSG =
  "❌ sticky-context.json is corrupt. Check gateway logs. " +
  "Fix or delete the file, then restart.";

// ── Plugin ───────────────────────────────────────────────────────────

const stickyContextPlugin = {
  id: "sticky-context",
  name: "Sticky Context",

  register(api: any) {
    const logger = api.logger ?? console;
    const cfg = getConfig(api.config, logger);

    // ── Inject on every turn ─────────────────────────────────────
    // Uses before_prompt_build (not legacy before_agent_start) so:
    //   1. Content lands in system prompt via appendSystemContext
    //      (not user prompt via prependContext)
    //   2. Respects allowPromptInjection operator policy
    //   3. Runs at correct priority in the prompt build pipeline
    api.on(
      "before_prompt_build",
      (_event: any, _ctx: any) => {
        const store = loadStore(resolveStorePath(api.config), logger);
        if (!store) return {};
        const content = renderSlots(store, cfg);
        if (!content) return {};
        return { appendSystemContext: content };
      },
      { priority: 5 },
    );

    // ── /sticky slash command (no LLM) ───────────────────────────
    //    /sticky           — list all slots
    //    /sticky raw <key> — show raw (unredacted) value for owner
    //    /sticky delete <key> — owner-level delete (bypasses pin)
    api.registerCommand({
      name: "sticky",
      description: "Show/manage sticky context slots",
      acceptsArgs: true,
      requireAuth: true,
      handler: (ctx: any) => {
        const args = (ctx.args ?? ctx.text ?? "").trim();
        const storePath = resolveStorePath(api.config);
        const store = loadStore(storePath, logger);
        if (!store) return { text: CORRUPT_STORE_MSG };

        // /sticky delete <key> — owner bypass for pinned slots
        if (args.startsWith("delete ")) {
          const key = sanitizeKey(args.slice(7).trim());
          if (!store.slots[key]) {
            return { text: `Slot "${key}" not found.` };
          }
          const was = store.slots[key];
          delete store.slots[key];
          atomicSave(storePath, store);
          return {
            text: `✅ Owner-deleted "${key}"${was.pinned ? " (was pinned)" : ""}. Budget: ${totalChars(store)}/${cfg.maxTotalChars} chars.`,
          };
        }

        // /sticky raw <key> — show unredacted content for owner
        if (args.startsWith("raw ")) {
          const key = sanitizeKey(args.slice(4).trim());
          const slot = store.slots[key];
          if (!slot) {
            return { text: `Slot "${key}" not found.` };
          }
          return {
            text: [
              `🔍 **${key}** (raw, unredacted)`,
              "",
              "```",
              slot.content,
              "```",
              "",
              `pinned: ${slot.pinned} | sensitive: ${slot.sensitive} | priority: ${slot.priority}`,
              `created: ${slot.created} | updated: ${slot.updated}`,
            ].join("\n"),
          };
        }

        // /sticky — list all
        const entries = sortedEntries(store);
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
          const flags = slotFlags(slot);
          const prio =
            slot.priority !== 0 ? ` (priority: ${slot.priority})` : "";
          const preview =
            slot.content.length > 120
              ? slot.content.slice(0, 120) + "…"
              : slot.content;
          lines.push(
            `**${key}**${flags}${prio} — ${slot.content.length} chars`,
          );
          lines.push(`> ${preview.replace(/\n/g, "\n> ")}`);
          lines.push("");
        }
        return { text: lines.join("\n") };
      },
    });

    // ── sticky_set ───────────────────────────────────────────────
    api.registerTool({
      name: "sticky_set",
      description: [
        "Create or update a sticky context slot. Sticky slots survive",
        "compaction — content is injected into the system prompt every turn.",
        "Use for: safety constraints, active task state, critical instructions,",
        "identity anchors. Budget: ~500 tokens (~2000 chars) total.",
        "Pinned slots cannot be modified by the agent.",
        "Sensitive and pinned flags can be set to true but never back to false.",
      ].join(" "),
      parameters: Type.Object({
        key: Type.String({
          description:
            "Slot name (lowercase, hyphens ok). e.g. safety-rules, active-task",
        }),
        content: Type.String({
          description:
            "Content to persist. Keep concise — eats budget every turn.",
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
              "If true, only the owner can modify or delete this slot. One-way: cannot be set back to false. Default false.",
            default: false,
          }),
        ),
        sensitive: Type.Optional(
          Type.Boolean({
            description:
              "If true, slot content is redacted (IPs, tokens, secrets) before injection into system prompt. One-way: cannot be set back to false. Default false.",
            default: false,
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const storePath = resolveStorePath(api.config);
        const store = loadStore(storePath, logger);
        if (!store) {
          return { content: [{ type: "text", text: CORRUPT_STORE_MSG }] };
        }

        const key = sanitizeKey(params.key);
        const existing = store.slots[key];

        // ── Guard: pinned slots are immutable to the agent ───────
        if (existing?.pinned) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Slot "${key}" is pinned. Agent cannot modify pinned slots. Owner can edit sticky-context.json directly or use /sticky delete ${key}.`,
              },
            ],
          };
        }

        // ── Validate content ─────────────────────────────────────
        if (!params.content || params.content.trim().length === 0) {
          return {
            content: [
              { type: "text", text: "❌ Content cannot be empty." },
            ],
          };
        }

        // ── Budget check ─────────────────────────────────────────
        const isNew = !existing;
        const oldChars = isNew ? 0 : existing.content.length;
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
        if (isNew && Object.keys(store.slots).length >= cfg.maxSlots) {
          return {
            content: [
              { type: "text", text: `❌ Max slots reached (${cfg.maxSlots}).` },
            ],
          };
        }

        // ── Ratchet: pinned/sensitive can escalate, never downgrade
        const newPinned = params.pinned || existing?.pinned || false;
        const newSensitive = params.sensitive || existing?.sensitive || false;

        const now = new Date().toISOString();
        store.slots[key] = {
          content: params.content,
          priority: params.priority ?? existing?.priority ?? 0,
          pinned: newPinned,
          sensitive: newSensitive,
          created: existing?.created ?? now,
          updated: now,
        };
        atomicSave(storePath, store);

        const total = totalChars(store);
        const flags = slotFlags(store.slots[key]);
        return {
          content: [
            {
              type: "text",
              text: `✅ ${isNew ? "Created" : "Updated"} sticky slot "${key}"${flags} (${newChars} chars). Budget: ${total}/${cfg.maxTotalChars} chars.`,
            },
          ],
        };
      },
    });

    // ── sticky_get ───────────────────────────────────────────────
    api.registerTool({
      name: "sticky_get",
      description:
        "Read sticky context slots. With key: read one slot. Without key: list all slots.",
      parameters: Type.Object({
        key: Type.Optional(
          Type.String({ description: "Slot name. Omit to list all." }),
        ),
      }),
      async execute(_id: string, params: any) {
        const store = loadStore(resolveStorePath(api.config), logger);
        if (!store) {
          return { content: [{ type: "text", text: CORRUPT_STORE_MSG }] };
        }

        if (params.key) {
          const key = sanitizeKey(params.key);
          const slot = store.slots[key];
          if (!slot) {
            return {
              content: [
                {
                  type: "text",
                  text: `Slot "${key}" not found. Available: ${Object.keys(store.slots).join(", ") || "(none)"}`,
                },
              ],
            };
          }
          // Agent sees redacted content for sensitive slots
          const visible = slot.sensitive
            ? { ...slot, content: redact(slot.content, cfg.redactPatterns) }
            : slot;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ key, ...visible }, null, 2),
              },
            ],
          };
        }
        const entries = sortedEntries(store);
        const total = totalChars(store);
        const summary = entries.map(
          ([k, s]) =>
            `${k}${slotFlags(s)} (${s.content.length} chars, priority ${s.priority})`,
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

    // ── sticky_delete ────────────────────────────────────────────
    api.registerTool({
      name: "sticky_delete",
      description:
        "Delete a sticky context slot. Pinned slots cannot be deleted by the agent. Owner can use /sticky delete <key> to bypass.",
      parameters: Type.Object({
        key: Type.String({ description: "Slot name to delete" }),
      }),
      async execute(_id: string, params: any) {
        const storePath = resolveStorePath(api.config);
        const store = loadStore(storePath, logger);
        if (!store) {
          return { content: [{ type: "text", text: CORRUPT_STORE_MSG }] };
        }

        const key = sanitizeKey(params.key);
        const slot = store.slots[key];
        if (!slot) {
          return {
            content: [
              { type: "text", text: `Slot "${key}" not found.` },
            ],
          };
        }
        if (slot.pinned) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Slot "${key}" is pinned. Agent cannot delete. Owner can use /sticky delete ${key}.`,
              },
            ],
          };
        }
        delete store.slots[key];
        atomicSave(storePath, store);
        return {
          content: [
            {
              type: "text",
              text: `✅ Deleted "${key}". Budget: ${totalChars(store)}/${cfg.maxTotalChars} chars.`,
            },
          ],
        };
      },
    });

    logger.info(
      `[sticky-context] Loaded. Budget: ${cfg.maxTotalChars} chars, max ${cfg.maxSlots} slots, ${cfg.redactPatterns.length} redact patterns. Hook: before_prompt_build.`,
    );
  },
};

export default stickyContextPlugin;
