/**
 * Outbound event notifications over a Unix socket.
 *
 * Connects to an external socket (e.g. a PM agent's RPC socket) and pushes
 * filtered session events as JSONL. Reconnects automatically on disconnect.
 */

import * as net from "node:net";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { serializeJsonLine } from "../rpc/jsonl.js";

/**
 * Event categories that map to one or more raw event types.
 *
 * - agent:      agent_start, agent_end
 * - turn:       turn_start, turn_end
 * - message:    message_start, message_end
 * - tool:       tool_execution_start, tool_execution_end
 * - error:      auto_retry_start, auto_retry_end, plus any event with isError
 * - compaction:  compaction_start, compaction_end
 * - all:        every event (no filtering)
 */
export type NotifyCategory = "agent" | "turn" | "message" | "tool" | "error" | "compaction" | "all";

const VALID_CATEGORIES = new Set<string>(["agent", "turn", "message", "tool", "error", "compaction", "all"]);

export function isValidNotifyCategory(value: string): value is NotifyCategory {
	return VALID_CATEGORIES.has(value);
}

const CATEGORY_EVENT_TYPES: Record<Exclude<NotifyCategory, "all">, Set<string>> = {
	agent: new Set(["agent_start", "agent_end"]),
	turn: new Set(["turn_start", "turn_end"]),
	message: new Set(["message_start", "message_end"]),
	tool: new Set(["tool_execution_start", "tool_execution_end"]),
	error: new Set(["auto_retry_start", "auto_retry_end"]),
	compaction: new Set(["compaction_start", "compaction_end"]),
};

function buildEventFilter(categories: NotifyCategory[]): (event: AgentSessionEvent) => boolean {
	if (categories.includes("all")) {
		return () => true;
	}

	const allowedTypes = new Set<string>();
	for (const cat of categories) {
		const types = CATEGORY_EVENT_TYPES[cat as Exclude<NotifyCategory, "all">];
		if (types) {
			for (const t of types) {
				allowedTypes.add(t);
			}
		}
	}

	const includeErrors = categories.includes("error");

	return (event: AgentSessionEvent) => {
		if (allowedTypes.has(event.type)) return true;
		// Include any tool_execution_end with isError when "error" category is active
		if (includeErrors && event.type === "tool_execution_end" && event.isError) return true;
		return false;
	};
}

export interface NotifySocketHandle {
	close(): void;
}

export interface NotifySocketOptions {
	/** Path to the target Unix socket to push events to */
	targetSocketPath: string;
	/** Event categories to send */
	categories: NotifyCategory[];
}

/**
 * Start pushing filtered session events to an external Unix socket.
 *
 * Wraps each event with the sender's PID and socket name for identification.
 * Reconnects on disconnect with backoff.
 */
export function startNotifySocket(runtimeHost: AgentSessionRuntime, options: NotifySocketOptions): NotifySocketHandle {
	const { targetSocketPath, categories } = options;
	const filter = buildEventFilter(categories);

	let socket: net.Socket | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let subscribedSession: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let reconnectDelay = 500;
	const MAX_RECONNECT_DELAY = 10000;

	const connect = () => {
		if (closed) return;

		socket = net.createConnection(targetSocketPath, () => {
			reconnectDelay = 500;
		});

		socket.on("error", () => {
			// Errors trigger close, handled there
		});

		socket.on("close", () => {
			socket = undefined;
			if (!closed) {
				reconnectTimer = setTimeout(() => {
					reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
					connect();
				}, reconnectDelay);
			}
		});

		// Discard any data sent back (we're a producer, not a consumer)
		socket.on("data", () => {});
	};

	const send = (obj: object) => {
		if (socket && !socket.destroyed) {
			socket.write(serializeJsonLine(obj));
		}
	};

	const subscribeToSession = () => {
		const session = runtimeHost.session;
		if (session === subscribedSession) return;
		unsubscribe?.();
		subscribedSession = session;
		unsubscribe = session.subscribe((event) => {
			if (filter(event)) {
				send({
					type: "notify",
					pid: process.pid,
					event,
				});
			}
		});
	};

	connect();
	subscribeToSession();

	// Periodically check for session swaps (TUI-initiated /new, /resume, fork)
	const sessionCheckInterval = setInterval(() => {
		subscribeToSession();
	}, 1000);

	return {
		close() {
			closed = true;
			clearInterval(sessionCheckInterval);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			unsubscribe?.();
			socket?.destroy();
		},
	};
}
