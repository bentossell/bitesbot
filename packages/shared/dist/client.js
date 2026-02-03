const request = async (options, path, init) => {
    const headers = new Headers(init?.headers);
    if (options.authToken) {
        headers.set("Authorization", `Bearer ${options.authToken}`);
    }
    if (!headers.has("Content-Type") && init?.body) {
        headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${options.baseUrl}${path}`, {
        ...init,
        headers,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Request failed: ${response.status}`);
    }
    return (await response.json());
};
export const createGatewayClient = (options) => ({
    health: () => request(options, "/health"),
    status: () => request(options, "/status"),
    send: (payload) => request(options, "/send", {
        method: "POST",
        body: JSON.stringify(payload),
    }),
    typing: (payload) => request(options, "/typing", {
        method: "POST",
        body: JSON.stringify(payload),
    }),
    ingest: (payload) => request(options, "/ingest", {
        method: "POST",
        body: JSON.stringify(payload),
    }),
});
const toWsUrl = (baseUrl, authToken) => {
    const wsBase = baseUrl.replace(/^http/, "ws");
    const url = new URL(wsBase);
    const trimmed = url.pathname.replace(/\/$/, "");
    url.pathname = trimmed === "" ? "/events" : `${trimmed}/events`;
    if (authToken) {
        url.searchParams.set("token", authToken);
    }
    return url.toString();
};
export const createGatewayEventsClient = (options) => {
    const socket = new WebSocket(toWsUrl(options.baseUrl, options.authToken));
    socket.addEventListener("open", () => {
        if (options.authToken) {
            socket.send(JSON.stringify({ type: "auth", token: options.authToken }));
        }
        options.onOpen?.();
    });
    socket.addEventListener("message", (message) => {
        try {
            const event = JSON.parse(String(message.data));
            options.onEvent?.(event);
        }
        catch {
            // ignore parse errors
        }
    });
    socket.addEventListener("close", () => {
        options.onClose?.();
    });
    socket.addEventListener("error", (event) => {
        options.onError?.(event);
    });
    return {
        socket,
        close: () => socket.close(),
    };
};
