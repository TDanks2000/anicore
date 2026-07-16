import type {
	SyncMonitorConfigResponse,
	SyncMonitorEvent,
	SyncMonitorStatus,
	SyncMonitorStatusResponse,
} from "@anicore/sync-monitor";
import {
	DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
	MAX_AUTO_SYNC_INTERVAL_MINUTES,
	SyncMonitorClient,
} from "@anicore/sync-monitor";
import {
	Activity,
	AlertTriangle,
	Clock3,
	Database,
	Moon,
	Pause,
	Play,
	PlugZap,
	RefreshCw,
	Save,
	Server,
	ShieldCheck,
	SlidersHorizontal,
	Square,
	Sun,
	TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "./theme-provider";

const defaultApiUrl =
	import.meta.env.VITE_ANICORE_API_URL?.trim() || "http://localhost:3000";
const configuredPollMs = Number(import.meta.env.VITE_SYNC_MONITOR_POLL_MS);
const pollMs =
	Number.isFinite(configuredPollMs) && configuredPollMs >= 1000
		? configuredPollMs
		: 2500;

type ConnectionState = "idle" | "loading" | "ready" | "error";
type ConfigMessage = { kind: "success" | "error"; text: string };

function loadStoredValue(key: string, fallback: string): string {
	if (typeof window === "undefined") return fallback;
	return window.localStorage.getItem(key) ?? fallback;
}

function formatDate(value?: string): string {
	if (!value) return "Not available";
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}

function formatDuration(start?: string, end?: string): string {
	if (!start) return "Not available";
	const startMs = new Date(start).getTime();
	const endMs = end ? new Date(end).getTime() : Date.now();
	const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 1) return `${remainder}s`;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatMs(value?: number): string {
	if (value === undefined) return "Not available";
	const seconds = Math.max(0, Math.round(value / 1000));
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 1) return `${remainder}s`;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatEta(value: number | null | undefined): string {
	if (value === null || value === undefined) return "Calculating";
	return formatMs(value * 1000);
}

function formatRate(value: number | undefined): string {
	if (value === undefined) return "Unknown";
	return `${value.toFixed(value >= 10 ? 0 : 1)}/min`;
}

function percent(status: SyncMonitorStatus | null): number {
	if (status?.progress) return status.progress.percent;
	if (!status || status.total <= 0) return 0;
	const current =
		status.currentIndex === null ? status.startIndex : status.currentIndex + 1;
	const done = Math.max(0, current - status.startIndex);
	return Math.max(0, Math.min(100, Math.round((done / status.total) * 100)));
}

function statusVariant(state?: SyncMonitorStatus["state"]) {
	if (state === "running") return "default";
	if (state === "completed") return "secondary";
	if (state === "failed") return "destructive";
	return "outline";
}

function describeConnection(state: ConnectionState): string {
	if (state === "loading") return "Connecting";
	if (state === "ready") return "Connected";
	if (state === "error") return "Needs attention";
	return "Idle";
}

export function App() {
	const { resolvedTheme, setTheme, theme } = useTheme();
	const [apiUrl, setApiUrl] = useState(() =>
		loadStoredValue("anicore.apiUrl", defaultApiUrl),
	);
	const [accessCode, setAccessCode] = useState(() =>
		typeof window === "undefined"
			? ""
			: (window.sessionStorage.getItem("anicore.monitorCode") ?? ""),
	);
	const [statusPayload, setStatusPayload] =
		useState<SyncMonitorStatusResponse | null>(null);
	const [configPayload, setConfigPayload] =
		useState<SyncMonitorConfigResponse | null>(null);
	const [parallelDraft, setParallelDraft] = useState("4");
	const [checkpointDraft, setCheckpointDraft] = useState("10");
	const [rateLimitDraft, setRateLimitDraft] = useState("1500");
	const [startModeDraft, setStartModeDraft] = useState<"sync" | "dry-run">(
		"dry-run",
	);
	const [startLimitDraft, setStartLimitDraft] = useState("5");
	const [startFromIndexDraft, setStartFromIndexDraft] = useState("");
	const [refreshIdsDraft, setRefreshIdsDraft] = useState(false);
	const [resetAllDraft, setResetAllDraft] = useState(false);
	const [autoSyncEnabledDraft, setAutoSyncEnabledDraft] = useState(true);
	const [autoSyncIntervalDraft, setAutoSyncIntervalDraft] = useState(
		String(DEFAULT_AUTO_SYNC_INTERVAL_MINUTES),
	);
	const [configDirty, setConfigDirty] = useState(false);
	const [configSaving, setConfigSaving] = useState(false);
	const [configMessage, setConfigMessage] = useState<ConfigMessage | null>(null);
	const [controlBusy, setControlBusy] = useState<string | null>(null);
	const [controlMessage, setControlMessage] = useState<string | null>(null);
	const [events, setEvents] = useState<SyncMonitorEvent[]>([]);
	const [connectionState, setConnectionState] =
		useState<ConnectionState>("idle");
	const [error, setError] = useState<string | null>(null);
	const [lastRefresh, setLastRefresh] = useState<string | null>(null);
	const refreshSequence = useRef(0);
	const refreshInFlight = useRef<number | null>(null);

	const client = useMemo(() => {
		if (!apiUrl || !accessCode) return null;
		return new SyncMonitorClient({ baseUrl: apiUrl, accessCode });
	}, [apiUrl, accessCode]);

	const refresh = useCallback(async (force = false) => {
		if (!client) {
			refreshSequence.current++;
			setConnectionState("idle");
			setError("Enter the API URL and monitor code to connect.");
			return;
		}
		if (refreshInFlight.current !== null && !force) return;

		const sequence = ++refreshSequence.current;
		refreshInFlight.current = sequence;

		setConnectionState((state) => (state === "ready" ? "ready" : "loading"));
		try {
			const [nextStatus, nextEvents, nextConfig] = await Promise.all([
				client.getStatus(),
				client.getEvents(80),
				client.getConfig(),
			]);
			if (sequence !== refreshSequence.current) return;
			setStatusPayload(nextStatus);
			setEvents(nextEvents.events);
			setConfigPayload(nextConfig);
			setLastRefresh(new Date().toISOString());
			setError(null);
			setConnectionState("ready");
		} catch (err) {
			if (sequence !== refreshSequence.current) return;
			setConnectionState("error");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (refreshInFlight.current === sequence) refreshInFlight.current = null;
		}
	}, [client]);

	useEffect(() => {
		window.localStorage.setItem("anicore.apiUrl", apiUrl);
	}, [apiUrl]);

	useEffect(() => {
		window.sessionStorage.setItem("anicore.monitorCode", accessCode);
	}, [accessCode]);

	useEffect(() => {
		void refresh();
		if (!client) return;
		const interval = window.setInterval(() => {
			if (!document.hidden) void refresh();
		}, pollMs);
		return () => {
			window.clearInterval(interval);
			refreshSequence.current++;
		};
	}, [client, refresh]);

	useEffect(() => {
		const runtime =
			configPayload?.runtime ?? statusPayload?.status?.runtimeConfig;
		if (configDirty) return;
		if (!runtime) return;
		setParallelDraft(String(runtime.parallel));
		setCheckpointDraft(String(runtime.checkpointEvery));
		setRateLimitDraft(String(runtime.rateLimitMs));
		setStartModeDraft(runtime.startMode);
		setStartLimitDraft(runtime.startLimit === null ? "" : String(runtime.startLimit));
		setStartFromIndexDraft(
			runtime.startFromIndex === null ? "" : String(runtime.startFromIndex),
		);
		setRefreshIdsDraft(runtime.refreshIds);
		setResetAllDraft(runtime.resetAll);
		setAutoSyncEnabledDraft(runtime.autoSyncEnabled);
		setAutoSyncIntervalDraft(String(runtime.autoSyncIntervalMinutes));
	}, [configDirty, configPayload, statusPayload]);

	const saveRuntimeConfig = useCallback(async () => {
		if (!client) return;

		const parallel = Number(parallelDraft);
		const checkpointEvery = Number(checkpointDraft);
		const rateLimitMs = Number(rateLimitDraft);
		const startLimit =
			startLimitDraft.trim() === "" ? null : Number(startLimitDraft);
		const startFromIndex =
			startFromIndexDraft.trim() === "" ? null : Number(startFromIndexDraft);
		const savedAutoSyncInterval =
			configPayload?.runtime.autoSyncIntervalMinutes ??
			statusPayload?.status?.runtimeConfig.autoSyncIntervalMinutes ??
			DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
		const autoSyncIntervalMinutes = autoSyncEnabledDraft
			? Number(autoSyncIntervalDraft)
			: savedAutoSyncInterval;
		setConfigSaving(true);
		setConfigMessage(null);

		try {
			if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) {
				throw new Error(
					"Parallel fetches must be an integer between 1 and 32.",
				);
			}
			if (
				!Number.isInteger(checkpointEvery) ||
				checkpointEvery < 1 ||
				checkpointEvery > 10000
			) {
				throw new Error(
					"Checkpoint every must be an integer between 1 and 10000.",
				);
			}
			if (!Number.isInteger(rateLimitMs) || rateLimitMs < 1 || rateLimitMs > 60000) {
				throw new Error("Rate limit must be an integer between 1 and 60000 ms.");
			}
			if (
				startLimit !== null &&
				(!Number.isInteger(startLimit) || startLimit < 0 || startLimit > 1000000)
			) {
				throw new Error("Start limit must be empty or an integer from 0 to 1000000.");
			}
			if (
				startFromIndex !== null &&
				(!Number.isInteger(startFromIndex) ||
					startFromIndex < 0 ||
					startFromIndex > 1000000)
			) {
				throw new Error(
					"Start index must be empty or an integer from 0 to 1000000.",
				);
			}
			if (
				autoSyncEnabledDraft &&
				(!Number.isInteger(autoSyncIntervalMinutes) ||
					autoSyncIntervalMinutes < 1 ||
					autoSyncIntervalMinutes > MAX_AUTO_SYNC_INTERVAL_MINUTES)
			) {
				throw new Error(
					`Automatic sync interval must be an integer from 1 to ${MAX_AUTO_SYNC_INTERVAL_MINUTES} minutes.`,
				);
			}
			const nextConfig = await client.updateConfig({
				parallel,
				checkpointEvery,
				rateLimitMs,
				startMode: startModeDraft,
				startLimit,
				startFromIndex,
				refreshIds: refreshIdsDraft,
				resetAll: resetAllDraft,
				autoSyncEnabled: autoSyncEnabledDraft,
				autoSyncIntervalMinutes,
			});
			setConfigPayload(nextConfig);
			setParallelDraft(String(nextConfig.runtime.parallel));
			setCheckpointDraft(String(nextConfig.runtime.checkpointEvery));
			setRateLimitDraft(String(nextConfig.runtime.rateLimitMs));
			setStartModeDraft(nextConfig.runtime.startMode);
			setStartLimitDraft(
				nextConfig.runtime.startLimit === null
					? ""
					: String(nextConfig.runtime.startLimit),
			);
			setStartFromIndexDraft(
				nextConfig.runtime.startFromIndex === null
					? ""
					: String(nextConfig.runtime.startFromIndex),
			);
			setRefreshIdsDraft(nextConfig.runtime.refreshIds);
			setResetAllDraft(nextConfig.runtime.resetAll);
			setAutoSyncEnabledDraft(nextConfig.runtime.autoSyncEnabled);
			setAutoSyncIntervalDraft(
				String(nextConfig.runtime.autoSyncIntervalMinutes),
			);
			setConfigDirty(false);
			setConfigMessage({
				kind: "success",
				text: "Runtime and automatic sync settings saved.",
			});
			await refresh(true);
		} catch (err) {
			setConfigMessage({
				kind: "error",
				text: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setConfigSaving(false);
		}
	}, [
		autoSyncEnabledDraft,
		autoSyncIntervalDraft,
		checkpointDraft,
		client,
		configPayload?.runtime.autoSyncIntervalMinutes,
		parallelDraft,
		rateLimitDraft,
		refresh,
		refreshIdsDraft,
		resetAllDraft,
		statusPayload?.status?.runtimeConfig.autoSyncIntervalMinutes,
		startFromIndexDraft,
		startLimitDraft,
		startModeDraft,
	]);

	const status = statusPayload?.status ?? null;
	const control = statusPayload?.control ?? null;
	const runtime = configPayload?.runtime ?? status?.runtimeConfig ?? null;
	const automation = configPayload?.automation ?? null;
	const autoSyncIntervalInvalid =
		autoSyncEnabledDraft &&
		(!Number.isInteger(Number(autoSyncIntervalDraft)) ||
			Number(autoSyncIntervalDraft) < 1 ||
			Number(autoSyncIntervalDraft) > MAX_AUTO_SYNC_INTERVAL_MINUTES);
	const saveShortcut =
		typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
			? "⌘S"
			: "Ctrl+S";

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
				return;
			}
			if (
				!client ||
				!configDirty ||
				configSaving ||
				autoSyncIntervalInvalid
			) {
				return;
			}
			event.preventDefault();
			void saveRuntimeConfig();
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		autoSyncIntervalInvalid,
		client,
		configDirty,
		configSaving,
		saveRuntimeConfig,
	]);
	const completion = percent(status);
	const processed = status?.progress?.processed ?? 0;
	const active = statusPayload?.active ?? false;
	const isPaused = status?.state === "paused" || control?.command === "pause";
	const startResumeLabel = isPaused ? "Resume" : active ? "Running" : "Start";

	const runControlAction = useCallback(
		async (
			name: string,
			action: () => Promise<unknown>,
			successMessage: string,
		) => {
			if (!client) return;
			setControlBusy(name);
			setControlMessage(null);

			try {
				await action();
				setControlMessage(successMessage);
				await refresh();
			} catch (err) {
				setControlMessage(err instanceof Error ? err.message : String(err));
			} finally {
				setControlBusy(null);
			}
		},
		[client, refresh],
	);

	return (
		<main className="min-h-screen bg-background text-foreground">
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
				<header className="grid gap-4 border-b border-border pb-5 lg:grid-cols-[1fr_auto] lg:items-end">
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">AniCore</Badge>
							<Badge
								variant={connectionState === "ready" ? "secondary" : "outline"}
							>
								{describeConnection(connectionState)}
							</Badge>
						</div>
						<div>
							<h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">
								Sync Monitor
							</h1>
							<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
								Live status from the machine running the AniCore sync process.
							</p>
						</div>
					</div>

					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							size="icon"
							aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
							onClick={() =>
								setTheme(resolvedTheme === "dark" ? "light" : "dark")
							}
							title={`Theme: ${theme}`}
						>
							{resolvedTheme === "dark" ? <Sun /> : <Moon />}
						</Button>
						<Button variant="outline" onClick={() => void refresh()}>
							<RefreshCw data-icon="inline-start" />
							Refresh
						</Button>
					</div>
				</header>

				<section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
					<Card>
						<CardHeader>
							<CardTitle>Connection</CardTitle>
							<CardDescription>
								Point this app at the API host exposing `/sync-monitor`.
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,360px)]">
							<label className="flex flex-col gap-2 text-sm font-medium">
								API URL
								<Input
									value={apiUrl}
									onChange={(event) => setApiUrl(event.target.value)}
									placeholder="http://192.168.1.45:3000"
								/>
							</label>
							<label className="flex flex-col gap-2 text-sm font-medium">
								Monitor code
								<Input
									value={accessCode}
									onChange={(event) => setAccessCode(event.target.value)}
									placeholder="Paste access code"
									type="password"
								/>
							</label>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Endpoint</CardTitle>
							<CardDescription>
								{lastRefresh
									? `Last refresh ${formatDate(lastRefresh)}`
									: "Not refreshed yet"}
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-3 text-sm">
							<div className="flex items-center justify-between gap-4">
								<span className="flex items-center gap-2 text-muted-foreground">
									<Server />
									API
								</span>
								<span className="max-w-44 truncate font-medium">{apiUrl}</span>
							</div>
							<div className="flex items-center justify-between gap-4">
								<span className="flex items-center gap-2 text-muted-foreground">
									<ShieldCheck />
									Auth
								</span>
								<span className="font-medium">
									{accessCode ? "Code set" : "Missing"}
								</span>
							</div>
						</CardContent>
					</Card>
				</section>

				{error ? (
					<Alert className="border-destructive/40">
						<AlertTriangle />
						<AlertTitle>Unable to load monitor</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
					<Card>
						<CardHeader>
							<CardTitle>Sync Controls</CardTitle>
							<CardDescription>
								Commands are written through the monitor API and applied by the
								sync loop.
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-4">
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={!client || (active && !isPaused) || controlBusy !== null}
									onClick={() =>
										void runControlAction(
											isPaused ? "resume" : "start",
											() => (isPaused ? client!.resume() : client!.start()),
											isPaused ? "Resume requested." : "Sync start requested.",
										)
									}
								>
									<Play data-icon="inline-start" />
									{startResumeLabel}
								</Button>
								<Button
									variant="outline"
									disabled={
										!client || !active || isPaused || controlBusy !== null
									}
									onClick={() =>
										void runControlAction(
											"pause",
											() => client!.pause(),
											"Pause requested.",
										)
									}
								>
									<Pause data-icon="inline-start" />
									Pause
								</Button>
								<Button
									variant="outline"
									disabled={
										!client || !active || !isPaused || controlBusy !== null
									}
									onClick={() =>
										void runControlAction(
											"resume",
											() => client!.resume(),
											"Resume requested.",
										)
									}
								>
									<Play data-icon="inline-start" />
									Resume
								</Button>
								<Button
									variant="destructive"
									disabled={!client || !active || controlBusy !== null}
									onClick={() =>
										void runControlAction(
											"stop",
											() => client!.stop(),
											"Stop requested.",
										)
									}
								>
									<Square data-icon="inline-start" />
									Stop
								</Button>
							</div>
							{controlMessage ? (
								<Alert>
									<AlertTitle>Control update</AlertTitle>
									<AlertDescription>{controlMessage}</AlertDescription>
								</Alert>
							) : null}
							<div className="grid gap-3 text-sm sm:grid-cols-3">
								<TextStat label="Command" value={control?.command ?? "None"} />
								<TextStat
									label="Requested"
									value={formatDate(control?.requestedAt ?? undefined)}
								/>
								<TextStat label="Active" value={active ? "Yes" : "No"} />
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Run State</CardTitle>
							<CardDescription>
								Latest monitor process projection from the API.
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3 text-sm">
							<div className="flex items-center justify-between gap-3">
								<span className="text-muted-foreground">PID</span>
								<span className="font-medium">{status?.pid ?? "None"}</span>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span className="text-muted-foreground">Mode</span>
								<span className="font-medium">{status?.mode ?? "Idle"}</span>
							</div>
							<div className="flex items-center justify-between gap-3">
								<span className="text-muted-foreground">Stage</span>
								<span className="font-medium">
									{status?.currentStage ?? "No active stage"}
								</span>
							</div>
						</CardContent>
					</Card>
				</section>

				<section className="grid gap-4 lg:grid-cols-4">
					<MetricCard
						icon={Activity}
						label="State"
						value={status?.state ?? "No run"}
					/>
					<MetricCard
						icon={Database}
						label="Processed"
						value={processed.toLocaleString()}
					/>
					<MetricCard
						icon={Clock3}
						label="Elapsed"
						value={formatDuration(status?.startedAt, status?.completedAt)}
					/>
					<MetricCard
						icon={PlugZap}
						label="Parallel"
						value={runtime ? `x${runtime.parallel}` : "Unknown"}
					/>
				</section>

				<section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
					<Card>
						<CardHeader>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div>
									<CardTitle>Run Progress</CardTitle>
									<CardDescription>
										{status
											? `${status.mode} from index ${status.startIndex} to ${status.endIndex}`
											: "Waiting for a monitor status file"}
									</CardDescription>
								</div>
								<Badge variant={statusVariant(status?.state)}>
									{status?.state ?? "idle"}
								</Badge>
							</div>
						</CardHeader>
						<CardContent className="flex flex-col gap-5">
							{connectionState === "loading" && !status ? (
								<Skeleton className="h-24 w-full" />
							) : (
								<>
									<div className="flex items-end justify-between gap-4">
										<div>
											<div className="text-4xl font-semibold tracking-normal">
												{completion}%
											</div>
											<div className="mt-1 text-sm text-muted-foreground">
												Current ID:{" "}
												{status?.currentAnilistId ?? "Not available"}
											</div>
										</div>
										<div className="text-right text-sm text-muted-foreground">
											<div>{status?.currentStage ?? "No active stage"}</div>
											<div>
												{statusPayload?.active
													? "Active process"
													: "No active process detected"}
											</div>
										</div>
									</div>
									<Progress value={completion} />
									<div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
										<Stat label="Created" value={status?.stats.created ?? 0} />
										<Stat label="Updated" value={status?.stats.updated ?? 0} />
										<Stat label="Failed" value={status?.stats.failed ?? 0} />
										<Stat
											label="Remaining"
											value={status?.progress?.remaining ?? 0}
										/>
										<TextStat
											label="Rate"
											value={formatRate(status?.progress?.ratePerMinute)}
										/>
										<TextStat
											label="ETA"
											value={formatEta(status?.progress?.etaSeconds)}
										/>
									</div>
									<RuntimeSnapshot status={status} />
									{status?.lastError ? (
										<Alert className="border-destructive/40">
											<AlertTitle>Latest error</AlertTitle>
											<AlertDescription>{status.lastError}</AlertDescription>
										</Alert>
									) : null}
								</>
							)}
						</CardContent>
					</Card>

					<div className="flex flex-col gap-4">
						<Card>
							<CardHeader>
								<CardTitle>Runtime Config</CardTitle>
								<CardDescription>
									Updates are written to the API host. Automatic runs refresh
									the AniList ID list and resync from index 0.
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								<div className="rounded-md border border-border bg-muted/30 p-3">
									<div className="flex flex-col gap-3">
										<label className="flex items-center gap-2 text-sm font-medium">
											<input
												checked={autoSyncEnabledDraft}
												className="size-4 accent-primary"
												type="checkbox"
												onChange={(event) => {
													setConfigDirty(true);
													setAutoSyncEnabledDraft(event.target.checked);
												}}
											/>
											Run sync automatically
										</label>
										<label className="flex flex-col gap-2 text-sm font-medium">
											Run every (minutes)
											<Input
												aria-invalid={autoSyncIntervalInvalid}
												disabled={!autoSyncEnabledDraft}
												min={1}
												max={MAX_AUTO_SYNC_INTERVAL_MINUTES}
												step={1}
												type="number"
												value={autoSyncIntervalDraft}
												onChange={(event) => {
													setConfigDirty(true);
													setAutoSyncIntervalDraft(event.target.value);
												}}
											/>
										</label>
										<div className="grid gap-2 text-xs text-muted-foreground">
											<div className="flex items-center justify-between gap-3">
												<span>Scheduler</span>
												<span>{automation?.state ?? "Not started"}</span>
											</div>
											<div className="flex items-center justify-between gap-3">
												<span>Next run</span>
												<span>{formatDate(automation?.nextRunAt ?? undefined)}</span>
											</div>
											{automation?.lastMessage ? (
												<p className="leading-5">{automation.lastMessage}</p>
											) : null}
										</div>
									</div>
								</div>
								<label className="flex flex-col gap-2 text-sm font-medium">
									Parallel fetches
									<Input
										min={1}
										max={32}
										step={1}
										type="number"
										value={parallelDraft}
										onChange={(event) => {
											setConfigDirty(true);
											setParallelDraft(event.target.value);
										}}
									/>
								</label>
								<label className="flex flex-col gap-2 text-sm font-medium">
									Checkpoint every
									<Input
										min={1}
										max={10000}
										step={1}
										type="number"
										value={checkpointDraft}
										onChange={(event) => {
											setConfigDirty(true);
											setCheckpointDraft(event.target.value);
										}}
									/>
								</label>
								<label className="flex flex-col gap-2 text-sm font-medium">
									AniList rate limit ms
									<Input
										min={1}
										max={60000}
										step={100}
										type="number"
										value={rateLimitDraft}
										onChange={(event) => {
											setConfigDirty(true);
											setRateLimitDraft(event.target.value);
										}}
									/>
								</label>
								<div className="grid gap-3 sm:grid-cols-2">
									<label className="flex flex-col gap-2 text-sm font-medium">
										Start mode
										<select
											className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
											value={startModeDraft}
											onChange={(event) => {
												setConfigDirty(true);
												setStartModeDraft(
													event.target.value === "sync" ? "sync" : "dry-run",
												);
											}}
										>
											<option value="dry-run">Dry run</option>
											<option value="sync">Sync</option>
										</select>
									</label>
									<label className="flex flex-col gap-2 text-sm font-medium">
										Start limit
										<Input
											min={0}
											max={1000000}
											step={1}
											type="number"
											value={startLimitDraft}
											onChange={(event) => {
												setConfigDirty(true);
												setStartLimitDraft(event.target.value);
											}}
											placeholder="No limit"
										/>
									</label>
								</div>
								<label className="flex flex-col gap-2 text-sm font-medium">
									Start from index
									<Input
										min={0}
										max={1000000}
										step={1}
										type="number"
										value={startFromIndexDraft}
										onChange={(event) => {
											setConfigDirty(true);
											setStartFromIndexDraft(event.target.value);
										}}
										placeholder="Use saved progress"
									/>
								</label>
								<label className="flex items-center gap-2 text-sm font-medium">
									<input
										checked={refreshIdsDraft}
										className="size-4 accent-primary"
										type="checkbox"
										onChange={(event) => {
											setConfigDirty(true);
											setRefreshIdsDraft(event.target.checked);
										}}
									/>
									Refresh AniList IDs on start
								</label>
								<label className="flex items-center gap-2 text-sm font-medium">
									<input
										checked={resetAllDraft}
										className="size-4 accent-primary"
										type="checkbox"
										onChange={(event) => {
											setConfigDirty(true);
											setResetAllDraft(event.target.checked);
										}}
									/>
									Reset progress on start
								</label>
								<Button
									onClick={() => void saveRuntimeConfig()}
									disabled={
										!client ||
										!configDirty ||
										configSaving ||
										autoSyncIntervalInvalid
									}
								>
									{configSaving ? (
										<RefreshCw className="animate-spin" data-icon="inline-start" />
									) : (
										<Save data-icon="inline-start" />
									)}
									{configSaving ? "Saving…" : `Save ${saveShortcut}`}
								</Button>
								{configMessage ? (
									<div
										className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
										role={configMessage.kind === "error" ? "alert" : "status"}
									>
										{configMessage.text}
									</div>
								) : null}
								<div className="grid gap-2 text-xs text-muted-foreground">
									<div className="flex items-center justify-between gap-3">
										<span className="flex items-center gap-2">
											<SlidersHorizontal />
											Updated by
										</span>
										<span>{runtime?.updatedBy ?? "default"}</span>
									</div>
									<div className="flex items-center justify-between gap-3">
										<span>Updated at</span>
										<span>{formatDate(runtime?.updatedAt)}</span>
									</div>
								</div>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Recent Events</CardTitle>
								<CardDescription>
									Latest entries from `events.jsonl`.
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
									{events.length === 0 ? (
										<div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
											No events loaded.
										</div>
									) : (
										events
											.slice()
											.reverse()
											.map((event) => (
												<EventRow
													key={`${event.at}-${event.message}`}
													event={event}
												/>
											))
									)}
								</div>
							</CardContent>
						</Card>
					</div>
				</section>
			</div>
		</main>
	);
}

function MetricCard({
	icon: Icon,
	label,
	value,
}: {
	icon: typeof Activity;
	label: string;
	value: string;
}) {
	return (
		<Card>
			<CardContent className="flex items-center justify-between gap-4 p-5">
				<div className="flex flex-col gap-1">
					<span className="text-sm text-muted-foreground">{label}</span>
					<span className="text-xl font-semibold tracking-normal">{value}</span>
				</div>
				<div className="flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
					<Icon />
				</div>
			</CardContent>
		</Card>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-md border border-border bg-muted/40 p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 text-lg font-semibold">{value.toLocaleString()}</div>
		</div>
	);
}

function TextStat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border border-border bg-muted/40 p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 text-lg font-semibold">{value}</div>
		</div>
	);
}

function RuntimeSnapshot({ status }: { status: SyncMonitorStatus | null }) {
	if (!status) return null;

	const batch = status.activeBatch;
	return (
		<div className="grid gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm lg:grid-cols-3">
			<div>
				<div className="text-xs text-muted-foreground">Current stage</div>
				<div className="mt-1 font-medium">{status.currentStage ?? "Idle"}</div>
			</div>
			<div>
				<div className="text-xs text-muted-foreground">Elapsed</div>
				<div className="mt-1 font-medium">
					{formatMs(status.progress?.elapsedMs)}
				</div>
			</div>
			<div>
				<div className="text-xs text-muted-foreground">Batch</div>
				<div className="mt-1 font-medium">
					{batch
						? `${batch.startIndex}-${batch.endIndex - 1} at x${batch.concurrency}`
						: "No active batch"}
				</div>
			</div>
			{batch ? (
				<div className="min-w-0 lg:col-span-3">
					<div className="text-xs text-muted-foreground">Batch IDs</div>
					<div className="mt-1 truncate font-mono text-xs">
						{batch.ids.join(", ")}
					</div>
				</div>
			) : null}
		</div>
	);
}

function EventRow({ event }: { event: SyncMonitorEvent }) {
	const tone =
		event.level === "error"
			? "border-destructive/40"
			: event.level === "warn"
				? "border-warning/50"
				: "border-border";

	return (
		<div className={`rounded-md border ${tone} bg-muted/30 p-3 text-sm`}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<TerminalSquare />
					<span className="truncate font-medium">{event.message}</span>
				</div>
				<Badge variant={event.level === "error" ? "destructive" : "outline"}>
					{event.level}
				</Badge>
			</div>
			<div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
				<span>{formatDate(event.at)}</span>
				{event.anilistId ? <span>ID {event.anilistId}</span> : null}
				{event.stage ? <span>{event.stage}</span> : null}
			</div>
		</div>
	);
}
