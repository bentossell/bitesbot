# Web UI for Bot Interaction - Implementation Plan

## Status: COMPLETED

## Overview

Build a web-based chat interface that mimics the Telegram experience for interacting with the bot. The UI will connect to the existing gateway infrastructure via WebSocket and HTTP endpoints.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Web Browser                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           Vanilla TypeScript Chat UI                 │    │
│  │  - Message bubbles (user/bot)                        │    │
│  │  - Streaming text display                            │    │
│  │  - Inline buttons                                    │    │
│  │  - Command suggestions                               │    │
│  │  - File attachments                                  │    │
│  │  - Typing indicators                                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Gateway Server (extended)                   │
│  ┌─────────────────┐    ┌─────────────────────────────┐     │
│  │  WebSocket      │    │  HTTP Endpoints             │     │
│  │  /events/web    │    │  /web/send                  │     │
│  │                 │    │  /web/upload                │     │
│  └─────────────────┘    │  /web/stream                │     │
│                         │  / (static files)           │     │
│                         └─────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Bridge (existing)                           │
│  - Routes web messages same as Telegram messages             │
│  - Session management                                        │
│  - CLI agent spawning                                        │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Frontend**: Vanilla TypeScript (no framework dependencies)
- **Styling**: CSS with Telegram-inspired design tokens
- **Communication**: WebSocket for real-time, fetch for uploads
- **Build**: TypeScript compiled and served from gateway

## Tasks

### Phase 1: Backend Integration

- [x] 1.1 Add web client WebSocket endpoint `/events/web`
- [x] 1.2 Create HTTP endpoint for web message sending `/web/send`
- [x] 1.3 Create HTTP endpoint for file uploads `/web/upload`
- [x] 1.4 Add streaming endpoint `/web/stream`
- [x] 1.5 Add web client identification (chatId = "web:{sessionId}")
- [x] 1.6 Serve static files from gateway

### Phase 2: Core UI Components

- [x] 2.1 Create project structure for web client
- [x] 2.2 Build message bubble component (user/bot variants)
- [x] 2.3 Build message input component with send button
- [x] 2.4 Build chat container with auto-scroll
- [x] 2.5 Implement streaming text rendering

### Phase 3: Telegram-like Features

- [x] 3.1 Inline keyboard buttons
- [x] 3.2 Typing indicator animation
- [x] 3.3 Command autocomplete (/, /new, /stop, etc.)
- [x] 3.4 File attachment support (drag & drop, button)
- [x] 3.5 Message timestamps and read receipts
- [x] 3.6 Message status indicators (sending, sent, error)

### Phase 4: Visual Design (Telegram-inspired)

- [x] 4.1 Color scheme (light mode with Telegram blue accent)
- [x] 4.2 Message bubble styling (rounded, shadows)
- [x] 4.3 Chat header with bot info and status
- [x] 4.4 Responsive layout (mobile-friendly)
- [x] 4.5 Smooth animations and transitions

### Phase 5: Polish & Integration

- [x] 5.1 Session persistence (localStorage)
- [x] 5.2 Reconnection handling
- [x] 5.3 Error states and notifications
- [x] 5.4 Keyboard shortcuts (Enter to send, etc.)
- [x] 5.5 Build script integration with npm

## File Structure

```
src/
├── web/
│   ├── index.html          # Entry HTML
│   ├── main.ts             # App entry point (all components inline)
│   └── styles/
│       └── main.css        # All styles (Telegram-inspired)
├── gateway/
│   └── server.ts           # Extended with web endpoints
```

## Usage

1. Build the project: `npm run build`
2. Start the gateway: `npm run gateway`
3. Open http://localhost:8787/ in your browser

## UI Features

```
┌──────────────────────────────────────────────┐
│  🤖 BitesBot                    ● Connected  │
├──────────────────────────────────────────────┤
│                                              │
│                    ┌─────────────────────┐   │
│                    │ Hello! How can I    │   │
│                    │ help you today?     │   │
│                    └─────────────────────┘   │
│                              14:32 ✓✓        │
│                                              │
│  ┌─────────────────────┐                     │
│  │ Can you help me     │                     │
│  │ write a function?   │                     │
│  └─────────────────────┘                     │
│  14:33                                       │
│                                              │
│                    ┌─────────────────────┐   │
│                    │ Sure! Let me help   │   │
│                    │ you with that...    │   │
│                    │ █ (streaming)       │   │
│                    └─────────────────────┘   │
│                                              │
│                    ┌───────┐ ┌───────────┐   │
│                    │ ✅ Yes│ │ ❌ Cancel │   │
│                    └───────┘ └───────────┘   │
│                                              │
├──────────────────────────────────────────────┤
│  / commands...                               │
├──────────────────────────────────────────────┤
│ ┌──────────────────────────────────┐  📎 ➤  │
│ │ Type a message...                │        │
│ └──────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Vanilla TS over React**: Keeps bundle small (~22KB), no framework dependency
2. **Reuse existing gateway**: No new server process needed
3. **Web-specific chatId**: `web:{uuid}` format to distinguish from Telegram
4. **Session persistence**: Store session ID in localStorage for resume
5. **Same message protocol**: Web messages follow same IncomingMessage format

## Commands Supported

- `/new` - Start fresh session
- `/stop` - Stop current session
- `/interrupt` - Skip current task
- `/status` - Show session status
- `/model` - Switch AI model
- `/use` - Switch CLI
- `/stream` - Toggle streaming
- `/verbose` - Toggle tool output
- `/spec` - Create plan for approval
- `/cron` - Manage scheduled jobs
- `/spawn` - Spawn background subagent
- `/subagents` - List subagent results
