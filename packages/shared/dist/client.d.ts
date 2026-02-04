import type { AgentActivityPayload, GatewayEvent, GatewayHealth, GatewayStatus, IngestRequest, IngestResponse, OutboundMessage, SendResponse, TypingRequest, TypingResponse } from "./types.js";
export type GatewayClientOptions = {
    baseUrl: string;
    authToken?: string;
};
export declare const createGatewayClient: (options: GatewayClientOptions) => {
    health: () => Promise<GatewayHealth>;
    status: () => Promise<GatewayStatus>;
    send: (payload: OutboundMessage) => Promise<SendResponse>;
    typing: (payload: TypingRequest) => Promise<TypingResponse>;
    ingest: (payload: IngestRequest) => Promise<IngestResponse>;
    activity: (payload: AgentActivityPayload) => Promise<{
        ok: boolean;
    }>;
};
export type GatewayEventsClient = {
    socket: WebSocket;
    close: () => void;
};
export type GatewayEventsOptions = {
    baseUrl: string;
    authToken?: string;
    onEvent?: (event: GatewayEvent) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: (error: Event) => void;
};
export declare const createGatewayEventsClient: (options: GatewayEventsOptions) => GatewayEventsClient;
//# sourceMappingURL=client.d.ts.map