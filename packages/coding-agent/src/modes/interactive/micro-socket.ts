/**
 * Unix socket side-channel for micro mode.
 *
 * Opens a unix socket that accepts RPC commands using the same protocol as --mode rpc,
 * but coexists with the interactive TUI. The TUI owns the terminal; the socket provides
 * structured programmatic input/output.
 *
 * Socket path: /tmp/pi-socket-<pid>.sock (also written to a discovery file).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "../rpc/rpc-types.js";

export interface MicroSocketServer {
	/** Absolute path to the unix socket */
	socketPath: string;
	/** Stop the server and clean up */
	close(): void;
}

export interface MicroSocketOptions {
	/** Custom socket name. When set, the socket file is pi-<name>.sock instead of pi-socket-<pid>.sock. */
	name?: string;
}

/**
 * Start a unix socket server that accepts RPC commands for the given session.
 * Events from the agent are forwarded to all connected clients.
 */
export function startMicroSocket(runtimeHost: AgentSessionRuntime, options?: MicroSocketOptions): MicroSocketServer {
	// Always access the current session through the runtime getter so we
	// never operate on a stale/disposed session after TUI-initiated /new,
	// /resume, or fork operations.
	const currentSession = () => runtimeHost.session;

	const socketName = options?.name;
	const socketFile = socketName ? `pi-${socketName}.sock` : `pi-socket-${process.pid}.sock`;
	const socketPath = path.join(os.tmpdir(), socketFile);

	// Clean up stale socket file
	try {
		fs.unlinkSync(socketPath);
	} catch {
		// Doesn't exist, fine
	}

	const clients = new Set<net.Socket>();

	const broadcast = (obj: object) => {
		const line = serializeJsonLine(obj);
		for (const client of clients) {
			if (!client.destroyed) {
				client.write(line);
			}
		}
	};

	// Subscribe to agent events and forward to all clients.
	// Track the subscribed session so we can detect runtime session swaps
	// (e.g. TUI-initiated /new or /resume) and re-subscribe automatically.
	let unsubscribe: (() => void) | undefined;
	let subscribedSession: AgentSession | undefined;

	const subscribeToSession = () => {
		const session = currentSession();
		if (session === subscribedSession) return;
		unsubscribe?.();
		subscribedSession = session;
		unsubscribe = session.subscribe((event) => {
			broadcast(event);
		});
	};

	subscribeToSession();

	// Pending extension UI requests per client
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		// Re-subscribe if the runtime session changed (TUI-initiated /new, /resume, fork)
		subscribeToSession();
		const session = currentSession();

		switch (command.type) {
			case "prompt": {
				// Default to "followUp" so socket prompts queue instead of
				// rejecting when the agent is already streaming.
				const streamingBehavior = command.streamingBehavior ?? "followUp";
				try {
					await session.prompt(command.message, {
						images: command.images,
						streamingBehavior,
						source: "rpc",
					});
					return success(id, "prompt");
				} catch (e) {
					return error(id, "prompt", e instanceof Error ? e.message : String(e));
				}
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				subscribeToSession();
				return success(id, "new_session", result);
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				return success(id, "cycle_model", result ?? null);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				return success(id, "cycle_thinking_level", level ? { level } : null);
			}

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const htmlPath = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path: htmlPath });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				subscribeToSession();
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				subscribeToSession();
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const cmd of session.extensionRunner?.getRegisteredCommands() ?? []) {
					commands.push({
						name: cmd.invocationName,
						description: cmd.description,
						source: "extension",
						sourceInfo: cmd.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const server = net.createServer((socket) => {
		clients.add(socket);

		const sendToClient = (obj: object) => {
			if (!socket.destroyed) {
				socket.write(serializeJsonLine(obj));
			}
		};

		const detach = attachJsonlLineReader(socket, (line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (parseError: unknown) {
				sendToClient(
					error(
						undefined,
						"parse",
						`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					),
				);
				return;
			}

			// Handle extension UI responses
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"type" in parsed &&
				parsed.type === "extension_ui_response"
			) {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pendingExtensionRequests.delete(response.id);
					pending.resolve(response);
				}
				return;
			}

			const command = parsed as RpcCommand;
			void (async () => {
				try {
					const response = await handleCommand(command);
					sendToClient(response);
				} catch (commandError: unknown) {
					sendToClient(
						error(
							command.id,
							command.type,
							commandError instanceof Error ? commandError.message : String(commandError),
						),
					);
				}
			})();
		});

		socket.on("close", () => {
			detach();
			clients.delete(socket);
		});

		socket.on("error", () => {
			detach();
			clients.delete(socket);
		});
	});

	server.listen(socketPath);

	// Write discovery file so other agents can find the socket
	const discoveryFile = socketName ? `pi-${socketName}.json` : `pi-socket-${process.pid}.json`;
	const discoveryPath = path.join(os.tmpdir(), discoveryFile);
	const session = currentSession();
	fs.writeFileSync(
		discoveryPath,
		JSON.stringify({
			pid: process.pid,
			name: socketName ?? null,
			socketPath,
			cwd: process.cwd(),
			sessionName: session.sessionName ?? null,
			startedAt: new Date().toISOString(),
		}),
	);

	return {
		socketPath,
		close() {
			unsubscribe?.();
			for (const client of clients) {
				client.destroy();
			}
			clients.clear();
			server.close();
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Already gone
			}
			try {
				fs.unlinkSync(discoveryPath);
			} catch {
				// Already gone
			}
		},
	};
}
