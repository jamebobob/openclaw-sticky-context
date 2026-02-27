# 📌 openclaw-sticky-context

**Persistent context slots that survive compaction.**

When OpenClaw compacts a conversation, it summarizes older history to free up
context window space. Critical instructions — safety rules, active constraints,
task state — can silently disappear. Your agent keeps running without knowing
anything was lost.

This plugin solves that by storing small blocks of content that get injected
into the **system prompt** on every turn. Because system prompt content is
never part of conversation history, it is never subject to compaction.

> Implements the architecture proposed in
> [openclaw/openclaw#25947](https://github.com/openclaw/openclaw/issues/25947)

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    Every Turn                            │
│                                                          │
│  1. User sends message                                   │
│  2. before_agent_start hook fires                        │
│  3. Plugin reads sticky-context.json from workspace      │
│  4. Renders all slots → markdown                         │
│  5. Returns { prependContext: markdown }                  │
│  6. Model sees sticky content in system prompt           │
│                                                          │
│  Compaction runs? ───→ Summarizes conversation history    │
│                       System prompt untouched ✓          │
│                       Sticky content still there ✓       │
│                       Next turn re-injects it ✓          │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
# Copy into extensions
cp -r openclaw-sticky-context ~/.openclaw/extensions/sticky-context
cd ~/.openclaw/extensions/sticky-context && npm install
```

### 2. Enable

```bash
openclaw config set plugins.entries.sticky-context.enabled true
```

Or add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "sticky-context": {
        enabled: true,
        config: {
          maxTotalChars: 2000,  // ~500 tokens budget
          maxSlots: 10
        }
      }
    }
  }
}
```

### 3. Allow tools

```bash
openclaw config set tools.allow '["sticky_set","sticky_get","sticky_delete"]'
```

### 4. Restart

```bash
openclaw gateway restart
# or: sudo systemctl restart openclaw
```

### 5. Verify

```bash
openclaw plugins list          # Should show sticky-context ✓
```

Send `/sticky` in chat to see current slots.

## Recommended Setup

After installing, create a pinned **task-discipline** slot. Without this, your
agent will update the `active-task` slot inconsistently — or clear it to
something like "No active build task" — and then go idle after compaction
because it no longer knows what it was doing.

This standing order forces the agent to keep its task state current:

```json
{
  "key": "task-discipline",
  "content": "STANDING ORDER: When working on any multi-step task, immediately run sticky_set(\"active-task\", \"<task description, file paths, current step, next step>\"). Update the slot after each step. This is your compaction insurance — without it you go idle after context compaction and have to be reminded. No exceptions.",
  "priority": 95,
  "pinned": true
}
```

You can tell your agent to create this, or add it directly to
`sticky-context.json` in your workspace:

```bash
python3 -c "
import json, datetime
path = '$HOME/.openclaw/workspace/sticky-context.json'
with open(path) as f:
    data = json.load(f)
now = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
data['slots']['task-discipline'] = {
    'content': 'STANDING ORDER: When working on any multi-step task, immediately run sticky_set(\"active-task\", \"<task description, file paths, current step, next step>\"). Update the slot after each step. This is your compaction insurance — without it you go idle after context compaction and have to be reminded. No exceptions.',
    'priority': 95,
    'pinned': True,
    'created': now,
    'updated': now
}
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print('Done')
"
```

Priority 95 puts it just below safety constraints (100) so it's always near
the top of the injected context. Pinning it prevents the agent from deleting it.

## Usage

### Agent tools (used by the AI agent during conversation)

| Tool | Description |
|------|-------------|
| `sticky_set` | Create or update a slot. Params: `key`, `content`, `priority?`, `pinned?` |
| `sticky_get` | Read one slot (by key) or list all slots (no key) |
| `sticky_delete` | Remove a slot. Cannot delete pinned slots. |

### Slash command (no LLM invocation)

| Command | Description |
|---------|-------------|
| `/sticky` | Show all slots with usage stats |

### Example: Safety constraints

Tell your agent:

> "Create a sticky slot called 'safety-rules' with priority 100 and pinned,
> containing: Never delete files without explicit user confirmation. Never
> run rm -rf. Never modify STANDING_ORDERS.md without asking first."

The agent calls `sticky_set`:
```json
{
  "key": "safety-rules",
  "content": "Never delete files without explicit user confirmation. Never run rm -rf. Never modify STANDING_ORDERS.md without asking first.",
  "priority": 100,
  "pinned": true
}
```

This content now appears in the system prompt on **every single turn**, and
the agent cannot delete it (pinned). It survives compaction, session restarts,
gateway restarts — everything except manually editing the JSON file.

### Example: Active task state

During a long multi-step task:

```json
{
  "key": "active-task",
  "content": "TASK: Migrating database schema v3→v4. DONE: users, posts tables. REMAINING: comments, tags. CONSTRAINT: Do not drop old columns until verification query passes.",
  "priority": 50,
  "pinned": false
}
```

After compaction, the agent still knows exactly where it left off.

### Example: Identity anchor

```json
{
  "key": "identity",
  "content": "You are Eve, JameBob's AI assistant. Your workspace is on walle. You communicate via Telegram. Current standing orders are in STANDING_ORDERS.md — read before any system changes.",
  "priority": 90,
  "pinned": true
}
```

## Architecture

### Why system prompt injection?

OpenClaw's compaction only affects **conversation history** — the back-and-forth
messages between user and agent. The system prompt (which includes workspace
bootstrap files like AGENTS.md, SOUL.md, TOOLS.md) is rebuilt fresh on every
turn from files on disk. It is never compacted.

By injecting sticky content via `api.on("before_agent_start")` returning
`{ prependContext: markdown }`, we place it in the one part of the context
window that compaction never touches.

### Token budget

Default: **2000 characters (~500 tokens)**. This is deliberately small.
Every character in sticky context is consumed on every turn, reducing the
space available for conversation. Keep slots concise.

The budget is enforced by the `sticky_set` tool — it will reject content
that would exceed the limit.

### Storage format

`<workspace>/sticky-context.json`:

```json
{
  "version": 1,
  "slots": {
    "safety-rules": {
      "content": "Never delete files without confirmation.",
      "priority": 100,
      "pinned": true,
      "created": "2026-02-26T19:00:00.000Z",
      "updated": "2026-02-26T19:00:00.000Z"
    },
    "active-task": {
      "content": "Migrating schema v3→v4. Done: users. Next: posts.",
      "priority": 50,
      "pinned": false,
      "created": "2026-02-26T20:00:00.000Z",
      "updated": "2026-02-26T20:30:00.000Z"
    }
  }
}
```

The file is human-readable and human-editable. You can add, modify, or delete
slots by editing it directly. Changes take effect on the next turn.

### Pinned slots

Pinned slots (`pinned: true`) cannot be deleted by the agent via the
`sticky_delete` tool. This is a safety mechanism — if you pin your safety
rules, the agent cannot remove them even if it hallucinates a reason to.

Only the user can delete pinned slots:
- Edit `sticky-context.json` directly
- Or: (future) `/sticky delete <key>` slash command

### Priority ordering

Slots with higher `priority` values appear first in the injected content.
Recommended ranges:

| Priority | Use case |
|----------|----------|
| 100+ | Safety constraints, hard rules |
| 50-99 | Identity, standing orders |
| 1-49 | Active task state, temporary context |
| 0 | Default (general notes) |

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `maxTotalChars` | `2000` | Max chars across all slots (~500 tokens) |
| `maxSlots` | `10` | Max number of slots |
| `file` | `sticky-context.json` | Storage file (relative to workspace) |
| `headerLabel` | `STICKY CONTEXT (survives compaction)` | Header in system prompt |

## Limitations

- **Token cost**: Sticky content is injected on every turn. 500 tokens of
  sticky context means 500 fewer tokens for conversation on every message.
  Keep it concise.

- **No mid-turn injection**: Content is injected at the start of each turn
  via `before_agent_start`. If the agent creates a slot during a turn, it won't
  be visible until the next turn. (The agent can still read it via `sticky_get`.)

- **Hook dependency**: Relies on the `before_agent_start` event. If OpenClaw
  changes the hook API, the injection mechanism may need updating.

- **before_compaction hooks not called**: Issue
  [#4967](https://github.com/openclaw/openclaw/issues/4967) documents that
  `before_compaction` and `after_compaction` hooks are defined but never
  called. This plugin works around this by not hooking into compaction at
  all — it operates entirely at the system prompt level.

## Troubleshooting

**Slots not appearing in context:**
```bash
# Check the plugin is loaded
openclaw plugins list | grep sticky

# Check the store file exists
cat ~/.openclaw/workspace/sticky-context.json
```

**Agent can't use tools:**
```bash
# Verify tools are allowed
openclaw config get tools.allow
# Should include sticky_set, sticky_get, sticky_delete
```

**Budget exceeded:**
- Check current usage with `/sticky`
- Delete unused slots or shorten existing ones
- Increase `maxTotalChars` in plugin config (but be aware of token cost)

## Related Issues

- [#25947](https://github.com/openclaw/openclaw/issues/25947) — Feature
  proposal: sticky context slots (the issue this plugin implements)
- [#24800](https://github.com/openclaw/openclaw/issues/24800) — Auto-compaction
  not triggered during tool-use loops
- [#4967](https://github.com/openclaw/openclaw/issues/4967) — before/after
  compaction hooks defined but never called
- [#5429](https://github.com/openclaw/openclaw/issues/5429) — Lost 2 days of
  agent context to silent compaction
- [#7477](https://github.com/openclaw/openclaw/issues/7477) — Safeguard mode
  silently fails on large contexts

## License

MIT
