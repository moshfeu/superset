import { EventEmitter } from "node:events";
import type { AgentDefinitionId } from "@superset/shared/agent-catalog";
import type {
	TerminalAgentBinding,
	TerminalAgentEndReason,
	TerminalAgentId,
} from "./types";

interface RecordEventInput {
	terminalId: string;
	workspaceId: string;
	eventType: string;
	agentId?: TerminalAgentId;
	agentSessionId?: string;
	definitionId?: AgentDefinitionId;
	occurredAt: number;
	cwd?: string;
}

interface LiveAgentMeta {
	cwd?: string;
	title?: string;
	color?: string;
}

export interface TerminalAgentBindingListFilter {
	agentId?: TerminalAgentId;
	definitionId?: AgentDefinitionId;
}

// "Detached" is the agent's own goodbye (SessionEnd hooks, the codex wrapper
// exit report) — not resumable. "exit"/"error" are terminal-side deaths.
const END_EVENT_REASONS = new Map<string, TerminalAgentEndReason>([
	["Detached", "detached"],
	["exit", "terminal-exited"],
	["error", "terminal-exited"],
]);

/**
 * Hook events can straggle in after the terminal died (async notify
 * callbacks, in-flight curls). Within this window of the recorded end, only
 * clear evidence of a NEW session may revive an ended row — a straggler
 * upsert would erase `endedAt`/`endReason` and destroy the resume candidate.
 */
const END_STRAGGLER_WINDOW_MS = 30_000;

export interface TerminalAgentBindingPersistence {
	load(): TerminalAgentBinding[];
	upsert(binding: TerminalAgentBinding): void;
	delete(terminalId: string): void;
	/**
	 * Retain the row but stamp `endedAt`/`endReason` so the agent session id
	 * survives as a resume candidate. Absent → the store falls back to
	 * deleting (pre-resume behavior).
	 */
	markEnded?(
		terminalId: string,
		reason: TerminalAgentEndReason,
		endedAt?: number,
	): { workspaceId: string } | undefined;
	/** End state of the terminal's row, if it exists and has ended. */
	getEnded?(
		terminalId: string,
	): { endedAt: number; agentSessionId?: string } | undefined;
	/**
	 * Liveness-joined reads (session `active` + workspace-owned). When
	 * provided, the store serves list/find from here so dead-terminal
	 * bindings are unrepresentable; the in-memory map then only backs
	 * `get()` (the fresh-launch wait path).
	 */
	listLiveByWorkspace?(
		workspaceId: string,
		filter?: TerminalAgentBindingListFilter,
	): TerminalAgentBinding[];
	listLive?(): TerminalAgentBinding[];
	findLiveActive?(
		workspaceId: string,
		agentId: TerminalAgentId,
		definitionId?: AgentDefinitionId,
	): TerminalAgentBinding | undefined;
}

/**
 * In-process tracker for which agent is alive in which terminal. Populated
 * by the hook receiver, drained on terminal exit, and optionally restored
 * from host-local persistence across host-service restarts.
 *
 * Emits `"change"` with the affected workspaceId after every mutation.
 */
export class TerminalAgentStore extends EventEmitter {
	private readonly byTerminal = new Map<string, TerminalAgentBinding>();
	private readonly persistence: TerminalAgentBindingPersistence | undefined;
	/**
	 * Live-derived metadata (cwd/title/color), keyed by terminalId. Never
	 * persisted — DB-backed reads (`listLiveByWorkspace` etc.) bypass
	 * `byTerminal` entirely, so this overlay is applied to every read path
	 * regardless of whether persistence is configured.
	 */
	private readonly liveMeta = new Map<string, LiveAgentMeta>();

	constructor(persistence?: TerminalAgentBindingPersistence) {
		super();
		this.persistence = persistence;

		for (const binding of persistence?.load() ?? []) {
			this.byTerminal.set(binding.terminalId, binding);
		}
	}

	recordEvent(input: RecordEventInput): void {
		const {
			terminalId,
			workspaceId,
			eventType,
			agentId,
			agentSessionId,
			definitionId,
			occurredAt,
			cwd,
		} = input;

		const endReason = END_EVENT_REASONS.get(eventType);
		if (endReason) {
			this.endBinding(terminalId, endReason, occurredAt);
			return;
		}

		if (cwd) {
			this.liveMeta.set(terminalId, {
				...this.liveMeta.get(terminalId),
				cwd,
			});
		}

		const existing = this.byTerminal.get(terminalId);
		if (!agentId && !existing) return;

		// A late event for a dead terminal must not resurrect its ended row
		// (the upsert would clear the resume state). Revive only on a fresh
		// session start, a different agent session id, or an event well past
		// the end (an agent without SessionStart hooks launched later).
		if (!existing && this.persistence?.getEnded) {
			const ended = this.persistence.getEnded(terminalId);
			if (
				ended !== undefined &&
				eventType !== "Attached" &&
				(agentSessionId === undefined ||
					agentSessionId === ended.agentSessionId) &&
				occurredAt - ended.endedAt <= END_STRAGGLER_WINDOW_MS
			) {
				return;
			}
		}

		const nextAgentId = agentId ?? existing?.agentId;
		if (!nextAgentId) return;

		// Only inherit identity metadata when agentId hasn't changed; otherwise
		// a swap event that omits agentSessionId/definitionId would inherit the
		// prior agent's values and corrupt definitionId-filtered reads.
		const prior =
			existing !== undefined && existing.agentId === nextAgentId
				? existing
				: undefined;

		const sessionChanged =
			prior !== undefined &&
			agentSessionId !== undefined &&
			prior.agentSessionId !== agentSessionId;

		const next: TerminalAgentBinding = {
			terminalId,
			workspaceId,
			agentId: nextAgentId,
			agentSessionId: agentSessionId ?? prior?.agentSessionId,
			definitionId: definitionId ?? prior?.definitionId,
			startedAt:
				prior !== undefined && !sessionChanged ? prior.startedAt : occurredAt,
			lastEventAt: occurredAt,
			lastEventType: eventType,
		};

		this.byTerminal.set(terminalId, next);
		this.persistence?.upsert(next);
		this.emit("change", workspaceId);
	}

	markTerminalExited(terminalId: string): void {
		this.endBinding(terminalId, "terminal-exited", Date.now());
	}

	/**
	 * Escape hatch for wedged working/permission state (an agent whose final
	 * Stop hook never fired — interrupts fire no hook at all). Forces the
	 * workspace's bindings (or just `terminalId`'s) to `Stop`, keeping
	 * lastEventAt so seen-gating still resolves to idle. Live agents
	 * re-assert within seconds via their next hook event, so clearing a
	 * genuinely working agent self-corrects.
	 */
	clearWorkspaceStatuses(workspaceId: string, onlyTerminalId?: string): void {
		let changed = false;
		for (const [terminalId, binding] of this.byTerminal) {
			if (binding.workspaceId !== workspaceId) continue;
			if (onlyTerminalId !== undefined && terminalId !== onlyTerminalId)
				continue;
			if (binding.lastEventType === "Stop") continue;
			const next: TerminalAgentBinding = { ...binding, lastEventType: "Stop" };
			this.byTerminal.set(terminalId, next);
			this.persistence?.upsert(next);
			changed = true;
		}
		if (changed) this.emit("change", workspaceId);
	}

	/**
	 * Called by the transcript watcher when it detects a new `agent-color`
	 * or `ai-title` line. No-ops (and skips the change event) when neither
	 * value actually changed, so a rescan tick doesn't cause needless
	 * cache invalidation.
	 */
	updateAgentMeta(
		terminalId: string,
		workspaceId: string,
		meta: { title?: string; color?: string },
	): void {
		const existing = this.liveMeta.get(terminalId);
		if (existing?.title === meta.title && existing?.color === meta.color) {
			return;
		}
		this.liveMeta.set(terminalId, { ...existing, ...meta });
		this.emit("change", workspaceId);
	}

	private withLiveMeta(binding: TerminalAgentBinding): TerminalAgentBinding {
		const meta = this.liveMeta.get(binding.terminalId);
		if (!meta) return binding;
		return { ...binding, ...meta };
	}

	get(terminalId: string): TerminalAgentBinding | undefined {
		const binding = this.byTerminal.get(terminalId);
		return binding ? this.withLiveMeta(binding) : undefined;
	}

	listByWorkspace(
		workspaceId: string,
		filter?: TerminalAgentBindingListFilter,
	): TerminalAgentBinding[] {
		if (this.persistence?.listLiveByWorkspace) {
			return this.persistence
				.listLiveByWorkspace(workspaceId, filter)
				.map((binding) => this.withLiveMeta(binding));
		}
		const out: TerminalAgentBinding[] = [];
		for (const binding of this.byTerminal.values()) {
			if (binding.workspaceId !== workspaceId) continue;
			if (filter?.agentId && binding.agentId !== filter.agentId) continue;
			if (filter?.definitionId && binding.definitionId !== filter.definitionId)
				continue;
			out.push(this.withLiveMeta(binding));
		}
		return out;
	}

	list(): TerminalAgentBinding[] {
		if (this.persistence?.listLive) {
			return this.persistence
				.listLive()
				.map((binding) => this.withLiveMeta(binding));
		}
		return [...this.byTerminal.values()].map((binding) =>
			this.withLiveMeta(binding),
		);
	}

	findActive(
		workspaceId: string,
		agentId: TerminalAgentId,
		definitionId?: AgentDefinitionId,
	): TerminalAgentBinding | undefined {
		if (this.persistence?.findLiveActive) {
			const binding = this.persistence.findLiveActive(
				workspaceId,
				agentId,
				definitionId,
			);
			return binding ? this.withLiveMeta(binding) : undefined;
		}
		let best: TerminalAgentBinding | undefined;
		for (const binding of this.byTerminal.values()) {
			if (binding.workspaceId !== workspaceId) continue;
			if (binding.agentId !== agentId) continue;
			if (definitionId !== undefined && binding.definitionId !== definitionId)
				continue;
			if (!best || binding.lastEventAt > best.lastEventAt) {
				best = binding;
			}
		}
		return best ? this.withLiveMeta(best) : undefined;
	}

	/**
	 * Drop the binding from the live view. With markEnded persistence the row
	 * is retained (stamped ended) so `agentSessionId` survives for resume;
	 * without it, hard-delete as before.
	 */
	private endBinding(
		terminalId: string,
		reason: TerminalAgentEndReason,
		endedAt: number,
	): void {
		const existing = this.byTerminal.get(terminalId);
		this.byTerminal.delete(terminalId);
		this.liveMeta.delete(terminalId);

		let marked: { workspaceId: string } | undefined;
		if (this.persistence?.markEnded) {
			marked = this.persistence.markEnded(terminalId, reason, endedAt);
		} else if (existing) {
			this.persistence?.delete(terminalId);
		}

		const workspaceId = marked?.workspaceId ?? existing?.workspaceId;
		if (workspaceId) this.emit("change", workspaceId);
	}
}
