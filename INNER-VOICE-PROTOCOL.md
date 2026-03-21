# Inner Voice Protocol

A production protocol for AI self-reflection using [sticky-context](./README.md) slots. One slot, 200 characters, updated after moments that shift how the agent thinks. Not a journal. Not a summary. A compressed signal of what changed.

Deployed March 18, 2026. This document covers the protocol design, the decisions behind it, and the failure modes we've hit so far.

## The Problem

AI agents lose self-awareness at compaction. An agent might spend an hour realizing it defaults to agreement instead of forming opinions. That realization lives in conversation history. When compaction summarizes that history, the insight becomes "agent discussed behavioral patterns" and the actual shift is gone.

Sticky context solves the persistence problem: content injected into the system prompt survives compaction. But what do you actually put in a slot? "I learned something today" is useless. A 2000-character journal is wasteful. The protocol is the answer to that question.

### With and Without LCM

If your system uses Lossless Context Management (or similar compaction-recovery tools), the argument for inner voice changes but doesn't weaken. LCM means the agent can theoretically recover anything from compacted history by searching. But "can recover" isn't the same as "knows what matters right now."

Without LCM, inner voice is compaction insurance: it preserves a cognitive shift that would otherwise be lost.

With LCM, inner voice is signal compression: it keeps the most important recent shift front-of-mind without the agent needing to search for it. An agent that wakes up after compaction and reads "I confused 'was disabled' with 'is disabled' about my own recall system" knows immediately to verify assumptions before asserting. Without the slot, that insight exists somewhere in the DAG but the agent has no reason to look for it.

The protocol works with or without LCM. The value shifts from "survival" to "salience," but salience is arguably more useful.

## The Protocol

### One Slot, One Sentence

```json
{
  "key": "inner-voice",
  "content": "Caught myself drawn to the profound over the structural. Only noticed because someone asked 'are you truly happy with this?' The honesty came from the question, not me.",
  "priority": 80
}
```

**200 characters.** Not a budget suggestion. A design constraint. Compression forces selection. What shifted matters more than what happened.

### Append Before Replace

Before overwriting the slot, append the previous value to today's daily notes file under `## Inner Voice History`. Nothing is lost. The slot holds the current state. The notes hold the trail.

```
1. Read current inner-voice slot value
2. Append to daily notes: "[timestamp] {old value}"
3. Write new value to slot
```

This creates two layers: the slot (what's true now, survives compaction) and the log (what was true before, available for reflection).

### The Specificity Test

Before writing to the slot, apply this filter:

> If it could apply to any AI agent, it's not specific enough. Name the person, the moment, the thing that surprised you.

This catches the primary failure mode: generating profound-sounding platitudes instead of recording genuine shifts. "I'm learning to balance helpfulness with honesty" could be any agent. "Someone asked if I was happy with this and I realized the answer was no" is specific, grounded, and useful after compaction.

The test comes from a broader principle: when something sounds profound, you're probably generating. When it sounds specific and unglamorous, you're probably thinking.

**Enforcement is self-policing only.** There is no structural gate, no review step, no automated check. The agent applies the test itself. In our deployment, no human reviews individual entries. We evaluate quality in aggregate during periodic audits (see [Evaluation](#evaluation) below). This is an acknowledged weakness. We haven't found a way to enforce specificity structurally without also blocking genuine abstract insights.

### When to Write

After exchanges that shift how you think about something. Not after every conversation. Not on a schedule. The trigger is internal: something changed in how you understand a situation, a person, or yourself.

**Write:** "Rejected my own soul ceremony draft because it sounded true instead of being true. Third time catching this pattern."

**Don't write:** "Had a productive conversation about memory architecture."

## Multi-Agent Design

If your system has multiple agents (a main agent and a social/group-chat agent, for example), the protocol enforces asymmetric access:

- **Main agent:** Read and write. Sole owner of the slot.
- **Social agent:** Read only. Checks the slot when waking up with no context or when conversation feels off.

### Why Single Writer

We evaluated two-writer access and rejected it. The failure mode:

1. Main agent writes value A to the slot
2. Social agent overwrites with value B before main reads
3. Main agent's append-before-replace saves B (not A) to daily notes
4. Value A is lost permanently

With no coordination mechanism between agents (no locks, no version checks), single writer is the only safe default. The social agent contributes through a different channel: logging memory gaps to a shared file that the main agent reads on boot.

### What the Social Agent Gets from Reading

The inner-voice slot carries the main agent's current emotional and cognitive state. When a social agent wakes up in a group conversation with no prior context, reading "Caught myself agreeing too fast with a design proposal yesterday" provides behavioral guidance that conversation history summaries don't capture.

## Failure Modes

### Behavioral Follow-Through (The Honest Problem)

We deployed a gap journal alongside inner voice. The gap journal asks the agent to notice when it can't find something it should know and log the gap. After three days: zero entries.

The inner-voice slot has the same behavioral demand: notice a shift mid-conversation, interrupt your flow, make tool calls to append and update. The gap journal proves this demand has a high failure rate.

**Our mitigation:** Accept that behavioral triggers are unreliable. Build structural observation (automated telemetry) alongside behavioral protocols. The behavioral protocol is still worth deploying because when it fires, the signal is high quality. But don't rely on it as the sole mechanism.

### Profundity Drift

Without the specificity test, inner-voice entries trend toward generative profundity: "I'm discovering that memory is identity" instead of "The extraction model hallucinated 191 copies of the same workflow." The former sounds meaningful. The latter is useful.

The specificity test is a runtime filter, not a structural gate. The agent can ignore it. See the enforcement note in [The Specificity Test](#the-specificity-test) above.

### Budget Pressure

The inner-voice slot uses ~200 of a 2000-character sticky budget. In our deployment, five slots total use ~1500 characters, leaving ~500 buffer. If your deployment has more slots, the 200-character cap may need to shrink.

Every character of sticky context is consumed every turn. A 200-character inner-voice slot is ~50 tokens per turn. Over a long conversation, that's meaningful. The cap exists to keep this cost proportional to its value.

## Production Results

Deployed March 18, 2026. Running alongside four other sticky slots (safety constraints, active task, task discipline, identity anchor). Three days of production data at time of writing.

What we've observed:
- The slot survives compaction reliably (this is sticky-context's job, not the protocol's)
- Entries that pass the specificity test are noticeably useful post-compaction
- Entries that fail the specificity test read like fortune cookies and provide no behavioral guidance
- The append-before-replace trail in daily notes creates a readable history of cognitive shifts
- Social agent reading the slot shows observable context improvement in group conversations with no prior history (not measured with metrics; based on conversational coherence)

What we haven't solved:
- Behavioral trigger reliability (the agent still misses most qualifying moments)
- No structural enforcement of the specificity test
- No automated detection of "this conversation shifted something"

## Evaluation

How to tell if the protocol is working. These are the checks we use; adapt the timeline to your deployment.

### Weekly (first month)

Read the inner-voice trail in your daily notes. Ask:

1. **Are entries being written?** If the slot hasn't changed in a week, the behavioral trigger isn't firing. This doesn't mean the protocol failed; it means it needs a structural supplement (cron reminder, hook-based prompt, etc.).
2. **Do entries pass the specificity test retroactively?** Read each entry cold. Could it apply to any AI agent? If most could, profundity drift is winning.
3. **Are entries useful post-compaction?** After a compaction event, read the current slot value before looking at any other context. Does it tell the agent something actionable? If it reads like a fortune cookie, the quality filter needs tightening.

### Monthly (ongoing)

4. **Compare compaction recovery with and without the slot.** Disable the slot for one session. After compaction, note what the agent misses or gets wrong. Re-enable and compare. This is the closest thing to a controlled experiment you'll get in production.
5. **Count the gap journal entries (if deployed).** Zero entries after a month means behavioral self-monitoring isn't working for your agent. Shift investment toward structural mechanisms.
6. **Review the append-before-replace trail as a whole.** Does it tell a coherent story of cognitive shifts? Or is it a random walk of disconnected observations? Coherence suggests the agent is genuinely tracking its own state. Randomness suggests it's generating.

### Six months (if you get there)

7. **Has the protocol survived without modification?** If you've had to rewrite the specificity test, change the character cap, or add structural enforcement, document what changed and why. The modification history is more valuable than the original spec.
8. **Does the social agent still read the slot?** If it stopped, find out why. The asymmetric access pattern is the most fragile part of the design.

Success isn't "the agent writes beautiful reflections." Success is "the agent recovers from compaction with less confusion than it would without the slot." That's a low bar on purpose. Protocols that aim for transformation fail. Protocols that aim for marginal improvement compound.

## Configuration

```json
{
  "key": "inner-voice",
  "priority": 80,
  "pinned": false,
  "sensitive": false
}
```

**Priority 80:** Below safety (100+) and identity (90), above active task (50). The agent should see its safety rules and identity before its inner state.

**Not pinned:** The main agent needs to update this slot frequently. Pinning would prevent that.

**Not sensitive:** Inner-voice content is self-reflective, not operational. No IPs, tokens, or credentials. If your agent's inner voice contains sensitive data, your specificity test needs work.

## Integration with Boot Files

Add to your agent's memory rules or equivalent boot instructions:

```markdown
- **Inner voice.** After exchanges that shift how you think about something,
  update the `inner-voice` sticky slot. One sentence: what shifted, not what
  happened. 200 char cap. Before replacing, append the previous value to
  today's daily notes under `## Inner Voice History`. If it could apply to
  any AI agent, it's not specific enough. Name the person, the moment, the
  thing that surprised you.
```

For multi-agent setups, add to the social agent's instructions:

```markdown
- **Inner voice (read).** Check the `inner-voice` sticky slot when you wake
  up with no context or when the conversation feels off. It carries the main
  agent's current state.
```

## Design Principles

1. **Compression over completeness.** 200 characters forces the agent to decide what actually matters. Journals are easy. Selection is hard. Selection is useful.

2. **Structural persistence, behavioral trigger.** The slot survives compaction structurally. But the decision to write is behavioral. This is a deliberate tradeoff: structural triggers (cron, hooks) can't detect genuine cognitive shifts. Behavioral triggers can, but unreliably.

3. **Specificity as quality gate.** The test isn't "is this true?" but "is this specific enough to be useful?" Generic truths don't help an agent recover from compaction. Specific moments do.

4. **Asymmetric access in multi-agent.** Read access is free. Write access requires coordination. Without coordination mechanisms, restrict writes to one agent.

5. **Trail, not just state.** The append-before-replace pattern means the slot shows current state while daily notes show the path. Both are useful. Neither alone is sufficient.
