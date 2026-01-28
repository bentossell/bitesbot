/**
 * BitesBot Web UI - Main Entry Point
 * A Telegram-like chat interface for interacting with the bot
 */

// Types
interface Message {
    id: string
    role: 'user' | 'assistant' | 'system'
    text: string
    timestamp: Date
    status?: 'sending' | 'sent' | 'error'
    attachments?: FileAttachment[]
    inlineButtons?: InlineButton[][]
    isStreaming?: boolean
}

interface FileAttachment {
    name: string
    size: number
    type: string
    file?: File
}

interface InlineButton {
    text: string
    callbackData: string
}

interface WebSocketMessage {
    type: string
    payload: unknown
}

// Commands for autocomplete
const COMMANDS = [
    { cmd: '/new', desc: 'Start fresh session' },
    { cmd: '/stop', desc: 'Stop current session' },
    { cmd: '/interrupt', desc: 'Skip current task, keep queue' },
    { cmd: '/status', desc: 'Show session status' },
    { cmd: '/model', desc: 'Switch AI model (opus/sonnet/haiku)' },
    { cmd: '/use', desc: 'Switch CLI (claude/droid)' },
    { cmd: '/stream', desc: 'Toggle streaming output' },
    { cmd: '/verbose', desc: 'Toggle tool output' },
    { cmd: '/spec', desc: 'Create plan for approval' },
    { cmd: '/cron', desc: 'Manage scheduled jobs' },
    { cmd: '/spawn', desc: 'Spawn background subagent' },
    { cmd: '/subagents', desc: 'List subagent results' },
]

// State
let sessionId = localStorage.getItem('bitesbot-session-id') || generateSessionId()
let messages: Message[] = []
let ws: WebSocket | null = null
let reconnectAttempts = 0
let pendingFiles: File[] = []
let isStreaming = false
let currentStreamingMessageId: string | null = null

// DOM Elements
const statusEl = document.getElementById('status') as HTMLSpanElement
const messagesEl = document.getElementById('messages') as HTMLDivElement
const inputEl = document.getElementById('message-input') as HTMLTextAreaElement
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement
const fileInputEl = document.getElementById('file-input') as HTMLInputElement
const attachmentsPreviewEl = document.getElementById('attachments-preview') as HTMLDivElement
const commandSuggestionsEl = document.getElementById('command-suggestions') as HTMLDivElement
const suggestionsListEl = document.getElementById('suggestions-list') as HTMLDivElement
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement
const closeSettingsBtn = document.getElementById('close-settings') as HTMLButtonElement
const newSessionBtn = document.getElementById('new-session-btn') as HTMLButtonElement
const chatContainerEl = document.getElementById('chat-container') as HTMLDivElement

// Generate session ID
function generateSessionId(): string {
    const id = 'web_' + Math.random().toString(36).substring(2, 15)
    localStorage.setItem('bitesbot-session-id', id)
    return id
}

// WebSocket connection
function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/events/web?session=${sessionId}`

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
        setStatus('online', 'Connected')
        reconnectAttempts = 0
        console.log('[ws] Connected')
    }

    ws.onclose = () => {
        setStatus('offline', 'Disconnected')
        console.log('[ws] Disconnected')
        scheduleReconnect()
    }

    ws.onerror = (error) => {
        console.error('[ws] Error:', error)
        setStatus('offline', 'Connection error')
    }

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data) as WebSocketMessage
            handleWebSocketMessage(data)
        } catch (e) {
            console.error('[ws] Failed to parse message:', e)
        }
    }
}

function scheduleReconnect() {
    if (reconnectAttempts >= 10) {
        setStatus('offline', 'Connection failed')
        return
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
    reconnectAttempts++

    setStatus('offline', `Reconnecting in ${delay / 1000}s...`)
    setTimeout(connect, delay)
}

function setStatus(state: 'online' | 'offline', text: string) {
    statusEl.textContent = text
    statusEl.className = `connection-status ${state}`
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(msg: WebSocketMessage) {
    console.log('[ws] Received:', msg.type, msg.payload)

    switch (msg.type) {
        case 'web.message': {
            const payload = msg.payload as { text: string; inlineButtons?: InlineButton[][] }
            addMessage({
                id: generateMessageId(),
                role: 'assistant',
                text: payload.text,
                timestamp: new Date(),
                inlineButtons: payload.inlineButtons,
            })
            isStreaming = false
            currentStreamingMessageId = null
            updateSendButton()
            break
        }

        case 'web.stream.start': {
            isStreaming = true
            currentStreamingMessageId = generateMessageId()
            updateSendButton()
            addMessage({
                id: currentStreamingMessageId,
                role: 'assistant',
                text: '',
                timestamp: new Date(),
                isStreaming: true,
            })
            break
        }

        case 'web.stream.chunk': {
            const payload = msg.payload as { text: string }
            if (currentStreamingMessageId) {
                updateStreamingMessage(currentStreamingMessageId, payload.text)
            }
            break
        }

        case 'web.stream.end': {
            const payload = msg.payload as { text?: string; inlineButtons?: InlineButton[][] }
            if (currentStreamingMessageId) {
                finalizeStreamingMessage(currentStreamingMessageId, payload.text, payload.inlineButtons)
            }
            isStreaming = false
            currentStreamingMessageId = null
            updateSendButton()
            break
        }

        case 'web.typing': {
            showTypingIndicator()
            break
        }

        case 'web.typing.stop': {
            hideTypingIndicator()
            break
        }

        case 'error': {
            const payload = msg.payload as { message: string }
            addMessage({
                id: generateMessageId(),
                role: 'system',
                text: `Error: ${payload.message}`,
                timestamp: new Date(),
            })
            break
        }

        case 'callback.response': {
            const payload = msg.payload as { text: string }
            addMessage({
                id: generateMessageId(),
                role: 'system',
                text: payload.text,
                timestamp: new Date(),
            })
            break
        }
    }
}

// Message functions
function generateMessageId(): string {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9)
}

function addMessage(message: Message) {
    // Remove welcome message if present
    const welcomeEl = messagesEl.querySelector('.welcome-message')
    if (welcomeEl) {
        welcomeEl.remove()
    }

    messages.push(message)
    renderMessage(message)
    scrollToBottom()
}

function renderMessage(message: Message) {
    const messageEl = document.createElement('div')
    messageEl.className = `message ${message.role === 'user' ? 'outgoing' : message.role === 'system' ? 'system-message' : 'incoming'}`
    messageEl.id = message.id

    if (message.role === 'system') {
        messageEl.textContent = message.text
        messagesEl.appendChild(messageEl)
        return
    }

    const bubbleEl = document.createElement('div')
    bubbleEl.className = 'message-bubble'

    // Message text
    const textEl = document.createElement('div')
    textEl.className = 'message-text'
    textEl.innerHTML = formatMessageText(message.text)
    if (message.isStreaming) {
        const cursor = document.createElement('span')
        cursor.className = 'streaming-cursor'
        textEl.appendChild(cursor)
    }
    bubbleEl.appendChild(textEl)

    // Attachments
    if (message.attachments?.length) {
        for (const attachment of message.attachments) {
            const attachEl = document.createElement('div')
            attachEl.className = 'message-attachment'
            attachEl.innerHTML = `
                <div class="message-attachment-icon">📎</div>
                <div class="message-attachment-info">
                    <div class="message-attachment-name">${escapeHtml(attachment.name)}</div>
                    <div class="message-attachment-size">${formatFileSize(attachment.size)}</div>
                </div>
            `
            bubbleEl.appendChild(attachEl)
        }
    }

    // Inline buttons
    if (message.inlineButtons?.length) {
        const keyboardEl = document.createElement('div')
        keyboardEl.className = 'inline-keyboard'
        for (const row of message.inlineButtons) {
            const rowEl = document.createElement('div')
            rowEl.className = 'inline-keyboard-row'
            for (const btn of row) {
                const btnEl = document.createElement('button')
                btnEl.className = 'inline-btn'
                btnEl.textContent = btn.text
                btnEl.onclick = () => handleInlineButtonClick(btn.callbackData, message.id)
                rowEl.appendChild(btnEl)
            }
            keyboardEl.appendChild(rowEl)
        }
        bubbleEl.appendChild(keyboardEl)
    }

    // Meta (time, status)
    const metaEl = document.createElement('div')
    metaEl.className = 'message-meta'

    const timeEl = document.createElement('span')
    timeEl.className = 'message-time'
    timeEl.textContent = formatTime(message.timestamp)
    metaEl.appendChild(timeEl)

    if (message.role === 'user') {
        const statusEl = document.createElement('span')
        statusEl.className = `message-status ${message.status || 'sent'}`
        statusEl.innerHTML = message.status === 'sending'
            ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" fill="none"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>'
        metaEl.appendChild(statusEl)
    }

    bubbleEl.appendChild(metaEl)
    messageEl.appendChild(bubbleEl)
    messagesEl.appendChild(messageEl)
}

function updateStreamingMessage(messageId: string, newText: string) {
    const messageEl = document.getElementById(messageId)
    if (!messageEl) return

    const textEl = messageEl.querySelector('.message-text')
    if (!textEl) return

    // Find the message and update its text
    const message = messages.find(m => m.id === messageId)
    if (message) {
        message.text = newText
    }

    textEl.innerHTML = formatMessageText(newText)
    const cursor = document.createElement('span')
    cursor.className = 'streaming-cursor'
    textEl.appendChild(cursor)

    scrollToBottom()
}

function finalizeStreamingMessage(messageId: string, finalText?: string, inlineButtons?: InlineButton[][]) {
    const messageEl = document.getElementById(messageId)
    if (!messageEl) return

    const message = messages.find(m => m.id === messageId)
    if (message) {
        message.isStreaming = false
        if (finalText !== undefined) {
            message.text = finalText
        }
        message.inlineButtons = inlineButtons
    }

    // Re-render the message
    const bubbleEl = messageEl.querySelector('.message-bubble')
    if (bubbleEl && message) {
        const textEl = bubbleEl.querySelector('.message-text')
        if (textEl) {
            textEl.innerHTML = formatMessageText(message.text)
        }

        // Add inline buttons if provided
        if (inlineButtons?.length) {
            const keyboardEl = document.createElement('div')
            keyboardEl.className = 'inline-keyboard'
            for (const row of inlineButtons) {
                const rowEl = document.createElement('div')
                rowEl.className = 'inline-keyboard-row'
                for (const btn of row) {
                    const btnEl = document.createElement('button')
                    btnEl.className = 'inline-btn'
                    btnEl.textContent = btn.text
                    btnEl.onclick = () => handleInlineButtonClick(btn.callbackData, messageId)
                    rowEl.appendChild(btnEl)
                }
                keyboardEl.appendChild(rowEl)
            }
            // Insert before meta
            const metaEl = bubbleEl.querySelector('.message-meta')
            if (metaEl) {
                bubbleEl.insertBefore(keyboardEl, metaEl)
            } else {
                bubbleEl.appendChild(keyboardEl)
            }
        }
    }
}

function formatMessageText(text: string): string {
    // Escape HTML first
    let formatted = escapeHtml(text)

    // Format code blocks
    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`
    })

    // Format inline code
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>')

    // Format bold
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

    // Format italic
    formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>')

    // Format links
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

    return formatted
}

function escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatContainerEl.scrollTop = chatContainerEl.scrollHeight
    })
}

// Typing indicator
let typingIndicatorEl: HTMLElement | null = null

function showTypingIndicator() {
    if (typingIndicatorEl) return

    typingIndicatorEl = document.createElement('div')
    typingIndicatorEl.className = 'typing-indicator'
    typingIndicatorEl.innerHTML = `
        <div class="typing-dots">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `
    messagesEl.appendChild(typingIndicatorEl)
    scrollToBottom()
}

function hideTypingIndicator() {
    if (typingIndicatorEl) {
        typingIndicatorEl.remove()
        typingIndicatorEl = null
    }
}

// Send message
async function sendMessage() {
    const text = inputEl.value.trim()
    if (!text && pendingFiles.length === 0) return

    // Create message
    const message: Message = {
        id: generateMessageId(),
        role: 'user',
        text: text,
        timestamp: new Date(),
        status: 'sending',
        attachments: pendingFiles.map(f => ({
            name: f.name,
            size: f.size,
            type: f.type,
            file: f,
        })),
    }

    addMessage(message)

    // Clear input
    inputEl.value = ''
    inputEl.style.height = 'auto'
    updateSendButton()
    clearPendingFiles()
    hideCommandSuggestions()

    // Send via WebSocket or HTTP
    try {
        if (pendingFiles.length > 0) {
            await sendWithFiles(text, message.attachments!)
        } else {
            sendViaWebSocket(text)
        }
        updateMessageStatus(message.id, 'sent')
    } catch (error) {
        console.error('Failed to send message:', error)
        updateMessageStatus(message.id, 'error')
    }
}

function sendViaWebSocket(text: string) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'web.send',
            payload: { text, sessionId }
        }))
    }
}

async function sendWithFiles(text: string, attachments: FileAttachment[]) {
    const formData = new FormData()
    formData.append('text', text)
    formData.append('sessionId', sessionId)

    for (const attachment of attachments) {
        if (attachment.file) {
            formData.append('files', attachment.file)
        }
    }

    const response = await fetch('/web/upload', {
        method: 'POST',
        body: formData,
    })

    if (!response.ok) {
        throw new Error('Upload failed')
    }
}

function updateMessageStatus(messageId: string, status: 'sending' | 'sent' | 'error') {
    const message = messages.find(m => m.id === messageId)
    if (message) {
        message.status = status
    }

    const messageEl = document.getElementById(messageId)
    if (messageEl) {
        const statusEl = messageEl.querySelector('.message-status')
        if (statusEl) {
            statusEl.className = `message-status ${status}`
        }
    }
}

// Inline button click
function handleInlineButtonClick(callbackData: string, messageId: string) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'web.callback',
            payload: { data: callbackData, messageId, sessionId }
        }))
    }

    // Remove buttons from message after clicking
    const messageEl = document.getElementById(messageId)
    if (messageEl) {
        const keyboardEl = messageEl.querySelector('.inline-keyboard')
        if (keyboardEl) {
            keyboardEl.remove()
        }
    }
}

// File handling
function handleFileSelect(files: FileList | null) {
    if (!files) return

    for (const file of Array.from(files)) {
        if (pendingFiles.length >= 5) {
            alert('Maximum 5 files allowed')
            break
        }
        pendingFiles.push(file)
    }

    renderPendingFiles()
    updateSendButton()
}

function renderPendingFiles() {
    if (pendingFiles.length === 0) {
        attachmentsPreviewEl.hidden = true
        return
    }

    attachmentsPreviewEl.hidden = false
    attachmentsPreviewEl.innerHTML = ''

    for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i]
        const itemEl = document.createElement('div')
        itemEl.className = 'attachment-item'
        itemEl.innerHTML = `
            <span>📎 ${escapeHtml(file.name)}</span>
            <button class="remove-attachment" data-index="${i}">&times;</button>
        `
        attachmentsPreviewEl.appendChild(itemEl)
    }
}

function clearPendingFiles() {
    pendingFiles = []
    renderPendingFiles()
    fileInputEl.value = ''
}

// Command suggestions
function showCommandSuggestions(query: string) {
    const filtered = COMMANDS.filter(c =>
        c.cmd.toLowerCase().startsWith(query.toLowerCase())
    )

    if (filtered.length === 0 || query === '') {
        hideCommandSuggestions()
        return
    }

    suggestionsListEl.innerHTML = ''
    for (const cmd of filtered) {
        const itemEl = document.createElement('div')
        itemEl.className = 'suggestion-item'
        itemEl.innerHTML = `
            <span class="suggestion-cmd">${escapeHtml(cmd.cmd)}</span>
            <span class="suggestion-desc">${escapeHtml(cmd.desc)}</span>
        `
        itemEl.onclick = () => {
            inputEl.value = cmd.cmd + ' '
            hideCommandSuggestions()
            inputEl.focus()
            updateSendButton()
        }
        suggestionsListEl.appendChild(itemEl)
    }

    commandSuggestionsEl.hidden = false
}

function hideCommandSuggestions() {
    commandSuggestionsEl.hidden = true
}

// Update send button state
function updateSendButton() {
    const hasContent = inputEl.value.trim().length > 0 || pendingFiles.length > 0
    sendBtn.disabled = !hasContent || isStreaming
}

// Auto-resize textarea
function autoResizeTextarea() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'
}

// Event listeners
inputEl.addEventListener('input', () => {
    autoResizeTextarea()
    updateSendButton()

    // Show command suggestions if typing a command
    const text = inputEl.value
    if (text.startsWith('/')) {
        showCommandSuggestions(text)
    } else {
        hideCommandSuggestions()
    }
})

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendMessage()
    }
})

sendBtn.addEventListener('click', sendMessage)

fileInputEl.addEventListener('change', () => {
    handleFileSelect(fileInputEl.files)
})

attachmentsPreviewEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('remove-attachment')) {
        const index = parseInt(target.dataset.index || '0', 10)
        pendingFiles.splice(index, 1)
        renderPendingFiles()
        updateSendButton()
    }
})

settingsBtn.addEventListener('click', () => {
    settingsModal.hidden = false
})

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.hidden = true
})

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.hidden = true
    }
})

newSessionBtn.addEventListener('click', () => {
    if (confirm('Start a new session? This will clear the current conversation.')) {
        sessionId = generateSessionId()
        messages = []
        messagesEl.innerHTML = `
            <div class="welcome-message">
                <div class="welcome-icon">👋</div>
                <h2>Welcome to BitesBot</h2>
                <p>Send a message to start chatting with the AI assistant.</p>
                <div class="command-hints">
                    <span class="hint">/new</span>
                    <span class="hint">/status</span>
                    <span class="hint">/model</span>
                    <span class="hint">/help</span>
                </div>
            </div>
        `
        // Reconnect with new session
        if (ws) {
            ws.close()
        }
        connect()
    }
})

// Drag and drop
chatContainerEl.addEventListener('dragover', (e) => {
    e.preventDefault()
    chatContainerEl.classList.add('dragover')
})

chatContainerEl.addEventListener('dragleave', () => {
    chatContainerEl.classList.remove('dragover')
})

chatContainerEl.addEventListener('drop', (e) => {
    e.preventDefault()
    chatContainerEl.classList.remove('dragover')
    handleFileSelect(e.dataTransfer?.files || null)
})

// Settings handlers
document.getElementById('model-select')?.addEventListener('change', (e) => {
    const model = (e.target as HTMLSelectElement).value
    inputEl.value = `/model ${model}`
    sendMessage()
})

document.getElementById('cli-select')?.addEventListener('change', (e) => {
    const cli = (e.target as HTMLSelectElement).value
    inputEl.value = `/use ${cli}`
    sendMessage()
})

document.getElementById('streaming-toggle')?.addEventListener('change', () => {
    inputEl.value = '/stream'
    sendMessage()
})

document.getElementById('verbose-toggle')?.addEventListener('change', () => {
    inputEl.value = '/verbose'
    sendMessage()
})

// Initialize
connect()
console.log('[app] BitesBot Web UI initialized')
console.log('[app] Session ID:', sessionId)
