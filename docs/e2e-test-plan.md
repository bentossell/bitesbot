# E2E Test Plan

Structured approach to testing the Telegram gateway with all CLI adapters.

## Test Order

Tests should run **per-agent** to minimize context switching and make debugging easier.

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

#### 2.7 Subagent Spawn
```
/new
/spawn Calculate 7 * 8 and report the answer

→ Expect (in order):
1. "🚀 Spawned: ..." acknowledgment
2. "🔄 Started: ..." notification
3. Main session still responsive (send "hi" → get response)
4. "✅ ..." completion with result containing "56"
```

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

#### 3.3 File Attachment Response
```
"Generate a CSV with columns: name, age. Add 3 rows of sample data. Send me the file."
→ Expect: Bot sends a .csv file attachment (not just text)
```

#### 3.4 Shell Command
```
"Run 'echo SHELLTEST123' and tell me the output"
→ Expect: Contains "SHELLTEST123"
```

#### 3.5 Tool Chaining
```
"Create /tmp/chain-test.txt with 'CHAIN123', read it back, tell me the contents"
→ Expect: Contains "CHAIN123"
```

#### 3.6 Search/Grep
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

### Phase 7: Voice & Media (if applicable)

#### 7.1 Voice Transcription
```
(Send voice message saying "Hello testing one two three")
→ Expect: Transcribed text includes "hello" and "testing"
```

#### 7.2 Image Analysis
```
(Send image of text "SAMPLE TEXT")
"What does this image show?"
→ Expect: Mentions "SAMPLE TEXT" or describes the image
```

### Phase 8: Cron & Scheduled Tasks

#### 8.1 Cron Creation
```
/cron 0 0 1 1 * Test cron message
→ Expect: "Created" or "scheduled" confirmation
/crons
→ Expect: Shows the new cron job
```

#### 8.2 Reminder
```
/remind 1m E2E test reminder
→ Expect: Confirmation with time
(wait 70 seconds)
→ Expect: Reminder message appears
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
| Session continuity | | | | |
| Session clear | | | | |
| Subagent spawn | | | | |
| Stop mid-task | | | | |
| File read | | | | |
| File create | | | | |
| File attachment | | | | |
| Shell command | | | | |
| Tool chaining | | | | |
| Error handling | | | | |
| Unicode | | | | |
| Long output | | | | |
| Message queuing | | | | |

---

## Known Issues to Watch

1. **Pi streaming** - May have timing issues with message updates
2. **Pi subagent** - Completion events may not fire correctly
3. **File attachments** - Bot may respond with text instead of file
4. **Large outputs** - Telegram 4096 char limit requires chunking

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
