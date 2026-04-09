/**
 * Outbound event notifications over a Unix socket.
 *
 * Connects to an external socket (e.g. a PM agent's RPC socket) and pushes
 * filtered session events. Supports two delivery modes:
 *
 * - "event" (default): raw JSONL event objects wrapped in a notify envelope
 * - "follow": formatted as RPC follow_up commands, injecting messages into
 *   the receiving agent's conversation so it sees and reacts to them
 *
 * Reconnects automatically on disconnect with exponential backoff.
 */

import * as net from "node:net";
import type { AssistantMessage } from "@mariozechner/pi-ai";
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

/** How notifications are delivered to the target socket. */
export type NotifyDeliver = "event" | "follow";

const VALID_CATEGORIES = new Set<string>(["agent", "turn", "message", "tool", "error", "compaction", "all"]);
const VALID_DELIVER_MODES = new Set<string>(["event", "follow"]);

export function isValidNotifyCategory(value: string): value is NotifyCategory {
	return VALID_CATEGORIES.has(value);
}

export function isValidNotifyDeliver(value: string): value is NotifyDeliver {
	return VALID_DELIVER_MODES.has(value);
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

/**
 * Format an event as a human-readable summary for follow_up delivery.
 */
function formatEventMessage(event: AgentSessionEvent): string {
	switch (event.type) {
		case "agent_start":
			return "[notify] agent started";

		case "agent_end": {
			const msgs = event.messages;
			const msgCount = msgs.length;
			return `[notify] agent finished (${msgCount} messages)`;
		}

		case "turn_start":
			return "[notify] turn started";

		case "turn_end": {
			const msg = event.message as AssistantMessage;
			const toolCount = event.toolResults?.length ?? 0;
			const stopReason = msg.stopReason ?? "unknown";
			if (toolCount > 0) {
				return `[notify] turn ended (${stopReason}, ${toolCount} tool call${toolCount > 1 ? "s" : ""})`;
			}
			return `[notify] turn ended (${stopReason})`;
		}

		case "message_start": {
			const role = event.message.role;
			if (role === "user") {
				const text = extractText(event.message.content);
				const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
				return `[notify] user message: ${preview}`;
			}
			return `[notify] ${role} message started`;
		}

		case "message_end": {
			const role = event.message.role;
			if (role === "assistant") {
				const msg = event.message as AssistantMessage;
				const text = extractText(msg.content);
				const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
				const stopReason = msg.stopReason ?? "unknown";
				return `[notify] assistant (${stopReason}): ${preview}`;
			}
			return `[notify] ${role} message ended`;
		}

		case "message_update": {
			return ""; // too noisy for follow mode, skip
		}

		case "tool_execution_start":
			return `[notify] tool started: ${event.toolName}`;

		case "tool_execution_update":
			return ""; // too noisy, skip

		case "tool_execution_end": {
			const status = event.isError ? "failed" : "completed";
			return `[notify] tool ${status}: ${event.toolName}`;
		}

		case "queue_update":
			return ""; // too noisy, skip

		case "compaction_start":
			return `[notify] compaction started (${event.reason})`;

		case "compaction_end": {
			if (event.aborted) return `[notify] compaction aborted`;
			if (event.willRetry) return `[notify] compaction failed, will retry: ${event.errorMessage ?? "unknown"}`;
			return `[notify] compaction done (${event.reason})`;
		}

		case "auto_retry_start":
			return `[notify] retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`;

		case "auto_retry_end":
			return event.success ? "[notify] retry succeeded" : `[notify] retry failed: ${event.finalError ?? "unknown"}`;

		default:
			return `[notify] ${(event as { type: string }).type}`;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}
	return "";
}

export interface NotifySocketHandle {
	close(): void;
}

export interface NotifySocketOptions {
	/** Path to the target Unix socket to push events to */
	targetSocketPath: string;
	/** Event categories to send */
	categories: NotifyCategory[];
	/** Delivery mode: "event" sends raw JSONL, "follow" sends RPC follow_up commands */
	deliver?: NotifyDeliver;
}

/**
 * Start pushing filtered session events to an external Unix socket.
 *
 * In "event" mode, wraps each event with the sender's PID.
 * In "follow" mode, formats events as human-readable RPC follow_up commands
 * so the receiving agent sees them as messages in its conversation.
 *
 * Reconnects on disconnect with exponential backoff.
 */
export function startNotifySocket(runtimeHost: AgentSessionRuntime, options: NotifySocketOptions): NotifySocketHandle {
	const { targetSocketPath, categories, deliver = "event" } = options;
	const filter = buildEventFilter(categories);

	let socket: net.Socket | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let subscribedSession: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let reconnectDelay = 500;
	const MAX_RECONNECT_DELAY = 10000;
	let notifyId = 0;

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

	const handleEvent = (event: AgentSessionEvent) => {
		if (!filter(event)) return;

		if (deliver === "follow") {
			const message = formatEventMessage(event);
			// Skip empty messages (noisy events like message_update)
			if (!message) return;
			send({
				type: "follow_up",
				id: `notify-${process.pid}-${notifyId++}`,
				message,
			});
		} else {
			send({
				type: "notify",
				pid: process.pid,
				event,
			});
		}
	};

	const subscribeToSession = () => {
		const session = runtimeHost.session;
		if (session === subscribedSession) return;
		unsubscribe?.();
		subscribedSession = session;
		unsubscribe = session.subscribe(handleEvent);
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
