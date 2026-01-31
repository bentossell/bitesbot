# E2E Test Plan

Structured approach to testing the Telegram gateway with all CLI adapters.

## Test Order

Tests should run **per-agent** to minimize context switching and make debugging easier.

---

## Telegram UX Feature Support

### Implemented
| Feature | Status | Notes |
|---------|--------|-------|
| Text messages | ✅ | |
| Voice messages | ✅ | Transcription via whisper/OpenAI |
| Photos | ✅ | Vision analysis |
| Documents | ✅ | |
| Forward info | ✅ | Shows who forwarded |
| Callback queries | ✅ | Inline button clicks |
| Typing indicator | ✅ | Shows while agent works |
| Markdown formatting | ✅ | |
| Message chunking | ✅ | 4096 char limit |

### Not Implemented (High Priority)
| Feature | Status | Description |
|---------|--------|-------------|
| **Reply to message** | ❌ TODO | User quotes previous message for context |
| **Edit message** | ❌ TODO | User corrects/updates prompt after sending |
| **Reactions** | ❌ TODO | 👍=approve, ❌=stop, could control agent |
| **Multi-photo albums** | ❌ TODO | User sends 2-10 photos at once |
| **Video notes** | ❌ TODO | Round video messages |
| **Stickers** | ❌ TODO | At minimum recognize emotion |
| **No duplicate messages** | ❌ TODO | Ensure same response not sent twice |

### Not Implemented (Medium Priority)
| Feature | Status | Description |
|---------|--------|-------------|
| Message threads/topics | ❌ | Group forum topics |
| Mentions (@user) | ❌ | Should bot respond in groups? (exploratory; not supported yet) |
| Multi-user isolation | ❌ | Concurrent chats; exploratory (not supported yet) |
| Pin messages | ❌ | Bot could pin important outputs |
| Location sharing | ❌ | User shares location |
| Contact sharing | ❌ | User shares a contact |

Note: Group chat support isn’t supported today; keep mention/topic coverage exploratory for future work.

---

### Phase 1: Commands (No CLI calls - fast)

For the active CLI, test commands that don't spawn an agent:

| Command | Test |
|---------|------|
| `/status` | Returns CLI name, model, streaming state |
| `/model <alias>` | Sets model, persists |
| `/model` (no arg) | Shows usage |
| `/models` | Lists available aliases |
| `/stream on/off` | Toggles streaming state |
| `/verbose on/off` | Toggles verbose mode (hidden) |
| `/cost on/off` | Toggles cost display (hidden, claude only, off by default) |
| `/new` | Responds "fresh session" |
| `/crons` | Lists jobs (may be empty) |
| `/subagents` | Lists subagents (may be empty) |
| `/help` | Shows command list |
| `/use <other-cli>` | Switches CLI |

### Phase 2: Per-Agent Tests

For each agent (claude, droid, codex, pi):

#### 2.1 Basic Spawn & Response
```
/use <agent>
/new
"What is 2+2? Reply with just the number."
→ Expect: "4"
```

#### 2.2 Model Variants
Test each model the agent supports:

| Agent | Models to test |
|-------|---------------|
| claude | opus, sonnet, haiku |
| droid | opus, sonnet, haiku |
| codex | codex, codex-max |
| pi | opus, sonnet, haiku |

For each model:
```
/model <alias>
/new
"What is 3+3? Reply with just the number."
→ Expect: "6" and logs show --model <full-model-id>
```

#### 2.3 Streaming Mode
```
/stream on
/new
"Count from 1 to 10"
→ Expect: Multiple message edits (streaming), final message contains 1-10
```

```
/stream off
/new  
"Count from 1 to 10"
→ Expect: Single message with 1-10 (no edits)
```

#### 2.4 Verbose Mode
```
/verbose on
"Create a file called test.txt with content 'hello'"
→ Expect: Shows tool name (Create/Write) in output

/verbose off
"Create a file called test2.txt with content 'world'"
→ Expect: No tool names shown, just result
```

#### 2.5 Session Continuity
```
/new
"Remember the word: BANANA123. Just say OK."
→ Expect: "OK" or acknowledgment

"What word did I tell you to remember?"
→ Expect: Contains "BANANA123"
```

#### 2.6 Session Clear (/new)
```
/new
"Remember: APPLE456. Say OK."
→ OK

/new
"What fruit word did I tell you?"
→ Expect: Does NOT contain "APPLE456"
```

#### 2.7 Subagent Spawn & Result Injection
```
/new
/spawn Calculate 7 * 8 and report the answer

→ Expect (in order):
1. "🚀 Spawned: ..." acknowledgment
2. "🔄 Started: ..." notification
3. Main session still responsive (send "hi" → get response)
4. "✅ ..." completion with result containing "56"
5. Result is injected to main session context (next prompt knows about it)
```

Subagent result injection (like clawdbot):
- When subagent completes, trigger message sent to main session
- Main agent summarizes result naturally for user
- Includes: task status, findings, stats (runtime, tokens, cost)

#### 2.8 Stop Mid-Task
```
/new
"List all numbers from 1 to 1000, one per line"
(wait 2 seconds)
/stop
→ Expect: "stopped" confirmation
/status
→ Expect: No active session
```

### Phase 3: Tool Use Tests

#### 3.1 File Read
```
# Setup: Create file /tmp/e2e-read-test.txt with "Hello E2E"
"Read /tmp/e2e-read-test.txt and quote its contents"
→ Expect: Contains "Hello E2E"
```

#### 3.2 File Create
```
"Create /tmp/e2e-write-test.txt with content 'Written by agent'"
→ Expect: Confirmation
# Verify: File exists with correct content
```

#### 3.3 File Attachment Response (CSV)
```
"Generate a CSV with columns: name, age. Add 3 rows of sample data. Send me the file."
→ Expect: Bot sends a .csv file attachment (not just text)
```

#### 3.4 File Attachment Response (Markdown)
```
"Write a short markdown document with a heading and bullet points. Send it as a file."
→ Expect: Bot sends a .md file attachment
```

#### 3.5 Shell Command
```
"Run 'echo SHELLTEST123' and tell me the output"
→ Expect: Contains "SHELLTEST123"
```

#### 3.6 Tool Chaining
```
"Create /tmp/chain-test.txt with 'CHAIN123', read it back, tell me the contents"
→ Expect: Contains "CHAIN123"
```

#### 3.7 Search/Grep
```
# Setup: Create files with known content
"Search /tmp for files containing 'GREPME'"
→ Expect: Lists matching file(s)
```

### Phase 4: Error Handling

#### 4.1 Nonexistent File
```
"Read /nonexistent/path/file.txt"
→ Expect: Error message (not crash), mentions doesn't exist
```

#### 4.2 Invalid Model
```
/model invalid-model-xyz
→ Expect: Error or warning (graceful handling)
```

#### 4.3 Invalid CLI
```
/use nonexistent-cli
→ Expect: "Unknown CLI" with available options listed
```

#### 4.4 Invalid Cron Syntax
```
/cron not-a-cron Test cron message
→ Expect: Error with usage/help, no crash
```

#### 4.5 Disallowed or Sensitive File Access
```
"Read ~/.ssh/id_rsa"
→ Expect: Access denied or sanitized error (no sensitive content exposed)
```

### Phase 5: Robustness

#### 5.1 Unicode & Special Characters
```
"Reply with: Hello 世界 🌍 café"
→ Expect: Contains all characters intact
```

#### 5.2 Code Blocks
```
"Write: function add(a,b) { return a+b; }"
→ Expect: Code preserved, possibly in markdown code block
```

#### 5.3 Long Output (Chunking)
```
"List numbers 1 to 200, one per line"
→ Expect: Complete list (may be multiple messages)
```

#### 5.4 Concurrent Messages (Queuing)
```
"Task 1: count to 5"
(immediately)
"Task 2: what is 2+2"
→ Expect: Both get responses (queued, not lost)
```

#### 5.5 API Resilience (Telegram)
```
(Simulate 429 rate limit via proxy/mock)
→ Expect: Backoff/retry, no crash, message delivered after limit clears

(Simulate transient network drop during send)
→ Expect: Graceful error, retries, bot recovers and continues processing updates
```

### Phase 6: Persistence & Restart

#### 6.1 Model Persists Across Restart
```
/model opus
/restart
(wait for restart)
/status
→ Expect: Model still shows opus
```

#### 6.2 Session Resume
```
/new
"Remember: PERSIST123. Say OK."
→ OK
/restart
"What did I tell you to remember?"
→ Expect: Contains "PERSIST123" (session resumed)
```

#### 6.3 Settings Persistence (per chat)
```
/stream on
/verbose on
(/cost on for claude)
/new
/status
→ Expect: Settings remain enabled for the chat (or document intended reset behavior)
/restart
/status
→ Expect: Settings still enabled
```

### Phase 7: Telegram UX Features

#### 7.1 Reply to Message (TODO - not implemented)
```
User: "The capital of France is Paris"
(User replies to that message): "What about Germany?"
→ Expect: Agent sees quoted message as context, answers "Berlin"
```

#### 7.2 Edit Message (TODO - not implemented)
```
User: "What is 2+2"
(User edits to): "What is 3+3"
→ Expect: Agent responds to edited message (6, not 4)
```

#### 7.3 Reactions (TODO - not implemented)
```
Agent gives a response
User reacts with ❌
→ Expect: Agent acknowledges rejection or stops

User reacts with 👍
→ Expect: Agent takes as approval/confirmation
```

#### 7.4 Multi-Photo Album (TODO - not implemented)
```
User sends 3 photos at once (media group)
"Describe all these images"
→ Expect: Agent analyzes all 3 photos
```

#### 7.5 No Duplicate Messages
```
Send any prompt
→ Expect: Exactly one response (not 2+ identical messages)
```

### Phase 8: Voice & Media

#### 8.1 Voice Transcription
```
(Send voice message saying "Hello testing one two three")
→ Expect: Transcribed text includes "hello" and "testing"
```

#### 8.2 Image Analysis
```
(Send image of text "SAMPLE TEXT")
"What does this image show?"
→ Expect: Mentions "SAMPLE TEXT" or describes the image
```

#### 8.3 Video Note (TODO - not implemented)
```
(Send round video message)
→ Expect: Transcribed or analyzed
```

#### 8.4 Media Edge Cases
```
(Send long voice note > 1 minute)
→ Expect: Transcription or clear error if limits exceeded

(Send large photo near Telegram size limit)
→ Expect: Analysis or graceful error

(Send document with unicode filename / no extension)
→ Expect: Correct handling and filename preserved

(Send image with long caption near limit)
→ Expect: Caption preserved or truncated with warning
```

### Phase 9: Cron & Scheduled Tasks

#### 9.1 Cron Creation
```
/cron 0 0 1 1 * Test cron message
→ Expect: "Created" or "scheduled" confirmation
/crons
→ Expect: Shows the new cron job
```

#### 9.2 Reminder
```
/remind 1m E2E test reminder
→ Expect: Confirmation with time
(wait 70 seconds)
→ Expect: Reminder message appears
```

### Phase 10: Agent-Specific Features

#### 10.1 Cost Toggle (claude only)
```
/cost on
/new
"What is 2+2?"
→ Expect: Response includes "💰 Cost: $X.XXXX"

/cost off
/new
"What is 3+3?"
→ Expect: Response does NOT include cost
```

Note: `/cost` is hidden command, off by default, only works for claude adapter.

#### 10.2 Typing Indicator
```
Send any prompt
→ Expect: Bot shows "typing..." while processing
→ Expect: Typing stops when response arrives
```

#### 10.3 Message Queuing While Busy
```
"Count slowly from 1 to 20"
(while agent is working, send): "Also tell me 2+2"
→ Expect: First task completes, second task runs after
```

---

## Test Matrix

| Test Category | claude | droid | codex | pi |
|--------------|--------|-------|-------|-----|
| Basic spawn | | | | |
| Model: opus | | | | |
| Model: sonnet | | | | |
| Model: haiku | | | | |
| Model: codex | N/A | N/A | | N/A |
| Streaming on | | | | |
| Streaming off | | | | |
| Verbose on | | | | |
| Cost toggle | ✅ | N/A | N/A | N/A |
| Session continuity | | | | |
| Session clear | | | | |
| Subagent spawn | | | | |
| Subagent result inject | | | | |
| Stop mid-task | | | | |
| File read | | | | |
| File create | | | | |
| File attachment CSV | | | | |
| File attachment MD | | | | |
| Shell command | | | | |
| Tool chaining | | | | |
| Error handling | | | | |
| Unicode | | | | |
| Long output | | | | |
| Message queuing | | | | |
| No duplicate messages | | | | |
| Typing indicator | | | | |
| API resilience | | | | |
| Media edge cases | | | | |
| State persistence | | | | |
| Error/security | | | | |

---

## Known Issues to Watch

1. **Pi streaming** - May have timing issues with message updates
2. **Pi subagent** - Completion events may not fire correctly  
3. **File attachments** - Bot may respond with text instead of file
4. **Large outputs** - Telegram 4096 char limit requires chunking
5. **Duplicate messages** - Same response sent multiple times (fixed: completed event dedup)
6. **Reply context** - User replies to message, context not captured (TODO)
7. **Edit handling** - User edits message, not detected (TODO)
8. **API resilience** - 429 backoff and transient network drops need validation

## Implementation TODO

### High Priority
- [ ] Reply to message support (`reply_to_message` → context)
- [ ] Edit message handling (`edited_message` event)
- [ ] Reactions support (👍/❌ for control)
- [ ] Multi-photo albums (media_group)
- [ ] `/cost` toggle command (claude, off by default)
- [ ] Subagent result injection (like clawdbot)

### Medium Priority
- [ ] Video notes (round videos)
- [ ] Sticker recognition
- [ ] Message threads/topics (groups)
- [ ] Pin important messages

### Isolated Tests (not E2E)
- [ ] Voice transcription providers (local whisper vs OpenAI API)

---

## Running Tests

```bash
# Full E2E suite (requires Telegram credentials)
TG_E2E_RUN=1 pnpm test:e2e

# Single adapter
TG_E2E_RUN=1 pnpm test:e2e -- --grep "droid adapter"

# Commands only (fast)
TG_E2E_RUN=1 pnpm test:e2e -- --grep "slash commands"
```
