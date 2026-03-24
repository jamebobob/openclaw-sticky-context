# openclaw-sticky-context

Persistent context slots that survive compaction. Your safety rules, identity, and task state injected into the system prompt every turn, invisible to compaction, because the system prompt is never part of conversation history.

Used in [openclaw-agent-privacy](https://github.com/jamebobob/openclaw-agent-privacy) for redacting operational details from group chat agents. Works standalone for any compaction-sensitive context.

## The Problem

When OpenClaw compacts a conversation, it summarizes older history to free up context window space. Anything the model was told in conversation (safety rules, constraints, active task state, identity context) can be silently lost in that summary. Your agent keeps running without knowing anything disappeared.

This happens because compaction only sees conversation history. It doesn't understand which instructions are load-bearing. A safety constraint from 50 messages ago looks the same as a casual remark from 50 messages ago. Both get compressed. One of them shouldn't have been.

## The Fix

This plugin stores small blocks of content in a JSON file and injects them into the system prompt on every turn. System prompt content is rebuilt from disk each turn. It's never part of conversation history. Compaction can't touch it.

```
┌─────────────────────────────────────────────────────┐
│ Every Turn                                          │
│                                                     │
│ 1. User sends message                              │
│ 2. before_prompt_build hook fires                   │
│ 3. Plugin reads sticky-context.json from workspace  │
│ 4. Renders slots → markdown (redacting sensitive)   │
│ 5. Returns { appendSystemContext: markdown }         │
│ 6. Model sees sticky content at end of system prompt│
│                                                     │
│ Compaction runs? → Summarizes conversation history  │
│   System prompt untouched ✓                         │
│   Sticky content still there ✓                      │
│   Next turn re-injects it ✓                         │
└─────────────────────────────────────────────────────┘
```

Implements the architecture proposed in [openclaw/openclaw#25947](https://github.com/openclaw/openclaw/issues/25947).

---

## What's New in v2

v2 was a ground-up rewrite after a three-way audit (the operator built v1, Claude audited, the live agent reviewed Claude's findings, the operator made final calls). Every change came from a real failure mode we either hit or identified during review.

| Change | Why |
|--------|-----|
| Hook: `before_prompt_build` + `appendSystemContext` | v1 used `before_agent_start` + `prependContext`, which put content in the user prompt. If an operator disables prompt injection, v1 content silently disappeared. v2 uses the correct hook for system-level content. |
| Atomic writes | v1 wrote directly to the JSON file. A crash mid-write would corrupt it and break every future session. v2 writes to a `.tmp` file then renames (atomic on POSIX). |
| `sensitive: true` flag | Slots containing IPs, tokens, or secrets get redacted before injection. The raw content stays on disk (for the human), but the model only sees `[IP]`, `[TOKEN]`, etc. For multi-agent setups, `social-*` agents never see sensitive slots at all — they are fully omitted from system prompt injection and return "not found" via `sticky_get`. |
| One-way ratchet | Agent can set `pinned: true` or `sensitive: true` but can never set them back to `false`. This prevents an agent from accidentally (or deliberately) downgrading its own safety constraints. |
| Pinned slots fully immutable | v1 pinned slots couldn't be deleted but could be modified. v2 pinned slots can't be touched at all by the agent. Owner uses `/sticky delete` or edits the JSON directly. |
| `/sticky raw` and `/sticky delete` | Owner-level commands. `raw` shows the unredacted content of a sensitive slot. `delete` bypasses the pin restriction. |
| Graceful corruption handling | v1 silently returned an empty store on corrupt JSON, losing all slots with no warning. v2's `loadStore` returns null, logs a loud error, and all callers degrade gracefully. Sticky content stops injecting until the file is fixed, but the gateway keeps running. |

---

## Install

```bash
# Copy into extensions
cp -r openclaw-sticky-context ~/.openclaw/extensions/sticky-context
cd ~/.openclaw/extensions/sticky-context && npm install

# Enable
openclaw config set plugins.entries.sticky-context.enabled true

# Allow the tools (APPEND to your existing tools.allow, don't replace it)
# Check your current list first:
openclaw config get tools.allow
# Then add the sticky tools to your existing list.

# Restart
openclaw gateway restart
# or: sudo systemctl restart openclaw

# Verify
openclaw plugins list  # Should show sticky-context ✓
```

Or add to `~/.openclaw/openclaw.json` (merge with your existing config):

```json5
{
  "tools": {
    "allow": [
      // ... your existing tools ...
      "sticky_set",
      "sticky_get",
      "sticky_delete"
    ]
  },
  "plugins": {
    "entries": {
      "sticky-context": {
        "enabled": true,
        "config": {
          "maxTotalChars": 2000,   // ~500 tokens budget
          "maxSlots": 10,
          "redactPatterns": []     // optional custom patterns
        }
      }
    }
  }
}
```

Send `/sticky` in chat to verify it's loaded and see current slots.

**Note:** Plugin config is read once at gateway startup. Changes to `maxTotalChars`, `maxSlots`, or `redactPatterns` in openclaw.json require a gateway restart to take effect. The store file (`sticky-context.json`) is re-read from disk on every turn, so manual slot edits are live immediately.

---

## Recommended: Task Discipline Slot

Create a pinned task-discipline slot. Without this, your agent will update its active-task slot inconsistently, or clear it to something like "No active build task," and then go idle after compaction because it no longer knows what it was doing.

```json
{
  "key": "task-discipline",
  "content": "STANDING ORDER: When working on any multi-step task, immediately run sticky_set(\"active-task\", \"<task description, file paths, current step, next step>\"). Update the slot after each step. This is your compaction insurance.",
  "priority": 95,
  "pinned": true
}
```

Priority 95 puts it just below safety constraints (100+) so it's always near the top. Pinning prevents the agent from deleting it.

See also **[Inner Voice Protocol](INNER-VOICE-PROTOCOL.md)** — a production protocol for AI self-reflection using a single sticky slot. Covers the specificity test, multi-agent access patterns, and failure modes from three weeks of deployment.

---

## Tools

| Tool | Description |
|------|-------------|
| `sticky_set` | Create or update a slot. Params: `key`, `content`, `priority?`, `pinned?`, `sensitive?` |
| `sticky_get` | Read one slot (by key) or list all slots (no key). Sensitive slots return redacted content for non-social agents. `social-*` agents get "not found" (sensitive slots are fully hidden, not just redacted). |
| `sticky_delete` | Remove a slot. Cannot delete pinned slots. |

**Key sanitization:** Slot keys are automatically lowercased, non-alphanumeric characters (except `-` and `_`) are replaced with hyphens, and keys are capped at 64 characters. For example, `"My Active Task"` becomes `"my-active-task"`.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/sticky` | Show all slots with usage stats |
| `/sticky raw <key>` | Show unredacted content (owner only, bypasses sensitive redaction) |
| `/sticky delete <key>` | Delete a slot (owner only, bypasses pin restriction) |

---

## The Sensitive Flag

Slots can contain data you want the agent to know about but not see in raw form. For example, an identity anchor ("I'm Assistant, running on a server at 10.0.0.50") where you don't want the model to see the IP address in the system prompt, because it might leak it in conversation.

Mark the slot as `sensitive: true`. The plugin runs the content through a redaction engine before injecting it into the system prompt. The model sees:

```
I'm Assistant, running on a server at [IP]
```

The raw content stays on disk. The human can see it via `/sticky raw identity`. The model only ever sees the redacted version.

**Multi-agent behavior:** For agents whose ID starts with `social-`, sensitive slots are completely hidden — not regex-redacted, but omitted entirely. The `before_prompt_build` hook skips them, and `sticky_get` returns "not found" (identical to a nonexistent slot, so the social agent has no way to know the slot exists). This prevents content that doesn't match any regex pattern from leaking to social agents. Non-social agents (including the main agent) continue to see regex-redacted content as before.

**Design note:** Sensitive slots show the 🔒 icon in tool output and `/sticky` listings, but the injected system prompt only shows 📌 for pinned slots, not 🔒 for sensitive ones. This is a rendering choice, not a security boundary. The model already knows a slot is sensitive through `sticky_get` results and tool confirmations.

### Built-in Redaction Patterns

| Pattern | Label | What it catches |
|---------|-------|-----------------|
| IPv4 addresses | `[IP]` | `192.168.1.1`, `10.0.0.255` (validated 0-255 octets) |
| IPv6 addresses | `[IP]` | Full-form 8-group hex addresses only. Compressed forms like `::1` or `fe80::1` are not matched. |
| Host:port | `[HOST:PORT]` | `://host:3000`, `@host:22` (requires protocol or @ prefix to avoid matching `file:line`) |
| SSH strings | `[SSH]` | `ssh user@host` |
| Secret env vars | `[SECRET]` | `API_KEY=value`, `SECRET: value`, `TOKEN=abc123` |
| Prefixed tokens | `[TOKEN]` | `sk-...`, `ghp_...`, `gho_...`, `vapi_...`, `Bearer ...` |

### Custom Patterns

Add your own via config:

```json5
{
  "plugins": {
    "entries": {
      "sticky-context": {
        "config": {
          "redactPatterns": [
            "your-regex-here||[LABEL]",
            "\\b\\d{3}-\\d{3}-\\d{4}\\b||[PHONE]"
          ]
        }
      }
    }
  }
}
```

Format: `regex||label`. The `||` separator is intentional (pipes are common in regex, double-pipe is not).

### One-Way Ratchet

Once a slot is marked `sensitive: true`, the agent cannot set it back to `false`. Same for `pinned: true`. This is a security model decision: the agent can escalate restrictions on itself but never relax them. Only the human can downgrade, by editing the JSON file directly.

---

## Examples

### Safety constraints (pin these)

```json
{
  "key": "safety-rules",
  "content": "Never delete files without explicit user confirmation. Never run rm -rf. Never modify STANDING_ORDERS.md without asking first.",
  "priority": 100,
  "pinned": true
}
```

This survives compaction, session restarts, gateway restarts. The agent cannot remove it.

### Active task state (don't pin, update often)

```json
{
  "key": "active-task",
  "content": "Migrating database schema v3 to v4. DONE: users, posts. NEXT: comments, tags. CONSTRAINT: Do not drop old columns until verification passes.",
  "priority": 50,
  "pinned": false
}
```

After compaction, the agent still knows exactly where it left off.

### Identity anchor (pin + sensitive)

```json
{
  "key": "identity",
  "content": "I'm Assistant. Running on HomeServer at 10.0.0.50. Human: Operator. Primary channel: Telegram.",
  "priority": 90,
  "pinned": true,
  "sensitive": true
}
```

The model sees the identity but IPs are redacted. The human sees everything via `/sticky raw identity`.

---

## Priority Ranges

| Priority | Use case |
|----------|----------|
| 100+ | Safety constraints, hard rules |
| 90-99 | Identity, standing orders |
| 50-89 | Active task state, project context |
| 1-49 | Temporary context, notes |
| 0 | Default |

Higher priority = rendered first in the system prompt.

---

## How It Actually Works

OpenClaw's compaction only affects conversation history (the back-and-forth messages between user and agent). The system prompt is rebuilt fresh on every turn from files on disk. It is never compacted.

By injecting sticky content via `api.on("before_prompt_build")` returning `{ appendSystemContext: markdown }`, we place it in the one part of the context window that compaction never touches.

The `before_prompt_build` hook (v2) is correct because:
- `appendSystemContext` places content at the end of the system prompt, clearly separated from workspace bootstrap files
- It respects the `allowPromptInjection` operator policy
- It runs at the correct priority in the prompt build pipeline

v1 used `before_agent_start` + `prependContext`, which put content in the user prompt and was silently dropped if an operator disabled prompt injection.

---

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `maxTotalChars` | 2000 | Max chars across all slots (~500 tokens) |
| `maxSlots` | 10 | Max number of slots |
| `file` | `sticky-context.json` | Storage file (relative to workspace) |
| `headerLabel` | `STICKY CONTEXT (survives compaction)` | Header in system prompt |
| `redactPatterns` | `[]` | Additional redaction patterns (`regex\|\|label` format) |

All config values are read once at gateway startup. Restart the gateway after changing them. The store file itself is re-read on every turn, so manual edits to slot content take effect immediately.

---

## Token Budget

Default: 2000 characters (~500 tokens). This is deliberately small. Every character of sticky context is consumed on every turn, reducing space for conversation. Keep slots concise.

The budget is enforced by `sticky_set`. It rejects content that would exceed the limit with a clear error showing available space.

---

## Storage

`<workspace>/sticky-context.json`:

```json
{
  "version": 1,
  "slots": {
    "safety-rules": {
      "content": "Never delete files without confirmation.",
      "priority": 100,
      "pinned": true,
      "sensitive": false,
      "created": "2026-02-26T19:00:00.000Z",
      "updated": "2026-02-26T19:00:00.000Z"
    }
  }
}
```

Human-readable, human-editable. Changes take effect on the next turn.

---

## Limitations

- **Token cost:** Sticky content is injected every turn. 500 tokens of sticky context = 500 fewer tokens for conversation on every message.
- **No mid-turn injection:** Content is injected at turn start. A slot created during a turn won't be visible until the next turn (but is readable via `sticky_get`).
- **Compaction hooks not called:** [#4967](https://github.com/openclaw/openclaw/issues/4967) documents that `before_compaction` and `after_compaction` hooks are defined but never called. This plugin sidesteps the issue entirely by operating at the system prompt level.
- **Compressed IPv6 not redacted:** The built-in IPv6 pattern only matches full-form 8-group addresses. Compressed forms (`::1`, `fe80::1`, `2001:db8::1`) are not caught. Add a custom pattern if your deployment uses compressed IPv6 in sensitive slots.

---

## Troubleshooting

**Slots not appearing in context:**
```bash
openclaw plugins list | grep sticky
cat ~/.openclaw/workspace/sticky-context.json
```

**Agent can't use tools:**
```bash
openclaw config get tools.allow
# Should include sticky_set, sticky_get, sticky_delete
```

**Budget exceeded:**
- Check usage with `/sticky`
- Delete unused slots or shorten existing ones
- Increase `maxTotalChars` (but be aware of the per-turn token cost)

**Corrupt store file:**
- Gateway logs will show `[sticky-context] CORRUPT store at <path>`. v2 degrades gracefully (no injection) rather than crashing. Fix or delete the file, then restart.

**Config changes not taking effect:**
- Plugin config (`maxTotalChars`, `maxSlots`, `redactPatterns`) is read once at startup. Restart the gateway after editing openclaw.json.

---

## Related Issues

- [#25947](https://github.com/openclaw/openclaw/issues/25947) - Feature proposal: sticky context slots (the issue this plugin implements)
- [#24800](https://github.com/openclaw/openclaw/issues/24800) - Auto-compaction not triggered during tool-use loops
- [#4967](https://github.com/openclaw/openclaw/issues/4967) - before/after compaction hooks defined but never called
- [#5429](https://github.com/openclaw/openclaw/issues/5429) - Lost 2 days of agent context to silent compaction
- [#7477](https://github.com/openclaw/openclaw/issues/7477) - Safeguard mode silently fails on large contexts

---

## Credits

v1 built by Jamey ([@jamebobob](https://github.com/jamebobob)). v2 rewrite audited by Claude, reviewed by Eve, shipped by Jamey. The three-way review process (build, audit, counter-review) caught bugs that none of us would have found alone.

The sensitive slot redaction feature was inspired by [darfaz](https://github.com/darfaz)'s suggestion on [#25947](https://github.com/openclaw/openclaw/issues/25947) about adding a redaction pass before injection for production deployments.

## License

MIT. See [LICENSE](LICENSE).
