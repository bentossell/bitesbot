import type {
  AgentActivityPayload,
  GatewayEvent,
  GatewayHealth,
  GatewayStatus,
  IngestRequest,
  IngestResponse,
  OutboundMessage,
  SendResponse,
  TypingRequest,
  TypingResponse,
} from "./types.js"

export type GatewayClientOptions = {
  baseUrl: string
  authToken?: string
}

const request = async <T>(
  options: GatewayClientOptions,
  path: string,
  init?: RequestInit
): Promise<T> => {
  const headers = new Headers(init?.headers)
  if (options.authToken) {
    headers.set("Authorization", `Bearer ${options.authToken}`)
  }
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json")
  }

  const response = await fetch(`${options.baseUrl}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed: ${response.status}`)
  }

  return (await response.json()) as T
}

export const createGatewayClient = (options: GatewayClientOptions) => ({
  health: () => request<GatewayHealth>(options, "/health"),
  status: () => request<GatewayStatus>(options, "/status"),
  send: (payload: OutboundMessage) =>
    request<SendResponse>(options, "/send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  typing: (payload: TypingRequest) =>
    request<TypingResponse>(options, "/typing", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  ingest: (payload: IngestRequest) =>
    request<IngestResponse>(options, "/ingest", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  activity: (payload: AgentActivityPayload) =>
    request<{ ok: boolean }>(options, "/activity", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
})

export type GatewayEventsClient = {
  socket: WebSocket
  close: () => void
}

export type GatewayEventsOptions = {
  baseUrl: string
  authToken?: string
  onEvent?: (event: GatewayEvent) => void
  onOpen?: () => void
  onClose?: () => void
  onError?: (error: Event) => void
}

const toWsUrl = (baseUrl: string, authToken?: string) => {
  const wsBase = baseUrl.replace(/^http/, "ws")
  const url = new URL(wsBase)
  const trimmed = url.pathname.replace(/\/$/, "")
  url.pathname = trimmed === "" ? "/events" : `${trimmed}/events`
  if (authToken) {
    url.searchParams.set("token", authToken)
  }
  return url.toString()
}

export const createGatewayEventsClient = (
  options: GatewayEventsOptions
): GatewayEventsClient => {
  const socket = new WebSocket(toWsUrl(options.baseUrl, options.authToken))

  socket.addEventListener("open", () => {
    if (options.authToken) {
      socket.send(
        JSON.stringify({ type: "auth", token: options.authToken })
      )
    }
    options.onOpen?.()
  })

  socket.addEventListener("message", (message) => {
    try {
      const event = JSON.parse(String(message.data)) as GatewayEvent
      options.onEvent?.(event)
    } catch {
      // ignore parse errors
    }
  })

  socket.addEventListener("close", () => {
    options.onClose?.()
  })

  socket.addEventListener("error", (event) => {
    options.onError?.(event)
  })

  return {
    socket,
    close: () => socket.close(),
  }
}
