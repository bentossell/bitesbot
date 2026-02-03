import type { GatewayEvent, GatewayHealth, GatewayStatus, OutboundMessage, SendResponse, TypingRequest, TypingResponse } from "./types.js";
export type GatewayClientOptions = {
    baseUrl: string;
    authToken?: string;
};
export declare const createGatewayClient: (options: GatewayClientOptions) => {
    health: () => Promise<GatewayHealth>;
    status: () => Promise<GatewayStatus>;
    send: (payload: OutboundMessage) => Promise<SendResponse>;
    typing: (payload: TypingRequest) => Promise<TypingResponse>;
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