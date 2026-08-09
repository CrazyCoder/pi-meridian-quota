import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "meridian-quota";
const REFRESH_MS = 3 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MERIDIAN_HEADER = "x-meridian-agent";

type Model = ExtensionContext["model"];
type Theme = ExtensionContext["ui"]["theme"];

export interface QuotaWindow {
  utilization: number;
  resetsAt?: number;
}

export interface MeridianQuota {
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
}

interface MeridianTarget {
  quotaUrl: string;
  agent: string;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readHeader(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1]?.trim() || undefined;
}

function parseWindow(value: unknown): QuotaWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Meridian quota bucket");
  }
  const bucket = value as Record<string, unknown>;
  const utilization = finiteNumber(bucket.utilization);
  if (utilization === undefined || utilization < 0 || utilization > 1) {
    throw new Error("Meridian quota bucket has invalid utilization");
  }
  const resetsAt = finiteNumber(bucket.resetsAt);
  return {
    utilization,
    ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
  };
}

export function parseMeridianQuota(value: unknown): MeridianQuota {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Meridian quota response");
  }
  const buckets = (value as Record<string, unknown>).buckets;
  if (!Array.isArray(buckets)) throw new Error("Meridian quota response has no buckets");

  const result: MeridianQuota = {};
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const type = (bucket as Record<string, unknown>).type;
    if (type === "five_hour") result.fiveHour = parseWindow(bucket);
    if (type === "seven_day") result.sevenDay = parseWindow(bucket);
  }
  if (!result.fiveHour && !result.sevenDay) {
    throw new Error("Meridian quota response has no five-hour or seven-day buckets");
  }
  return result;
}

function formatReset(resetsAt: number, now = Date.now()): string {
  const remaining = Math.max(0, resetsAt - now);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (remaining >= day) return `${Math.ceil(remaining / day)}d`;
  if (remaining >= hour) return `${Math.ceil(remaining / hour)}h`;
  return `${Math.max(1, Math.ceil(remaining / minute))}m`;
}

function percent(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.utilization * 100)));
}

function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

function renderWindow(label: string, window: QuotaWindow, theme: Theme, now: number): string {
  const value = percent(window);
  const filled = Math.round((value / 100) * 8);
  const bar = theme.fg(colorForPercent(value), "█".repeat(filled)) +
    theme.fg("dim", "░".repeat(8 - filled));
  const reset = window.resetsAt ? theme.fg("dim", ` ⟳ ${formatReset(window.resetsAt, now)}`) : "";
  return theme.fg("muted", `${label} `) + bar + " " +
    theme.fg(colorForPercent(value), `${value}%`) + reset;
}

export function renderMeridianQuota(quota: MeridianQuota, theme: Theme, now = Date.now()): string {
  const windows: string[] = [];
  if (quota.fiveHour) windows.push(renderWindow("5h", quota.fiveHour, theme, now));
  if (quota.sevenDay) windows.push(renderWindow("7d", quota.sevenDay, theme, now));
  return theme.fg("dim", "Meridian ") + windows.join(" ");
}

async function resolveMeridianTarget(ctx: ExtensionContext, model: Model): Promise<MeridianTarget | undefined> {
  if (!model || ctx.modelRegistry.isUsingOAuth(model)) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const agent = readHeader(auth.headers, MERIDIAN_HEADER);
  if (!agent) return undefined;

  const baseUrl = auth.baseUrl || model.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  let quotaUrl: string;
  try {
    quotaUrl = new URL("/v1/usage/quota", baseUrl).toString();
  } catch {
    throw new Error("Meridian model has an invalid base URL");
  }
  return { quotaUrl, agent };
}

async function fetchMeridianQuota(target: MeridianTarget): Promise<MeridianQuota> {
  const response = await fetch(target.quotaUrl, {
    headers: {
      accept: "application/json",
      [MERIDIAN_HEADER]: target.agent,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Meridian quota request failed with HTTP ${response.status}`);
  return parseMeridianQuota(await response.json());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function meridianQuotaExtension(pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | undefined;
  let activeModel: Model;
  let stopRefresh: (() => void) | undefined;
  let generation = 0;

  const clearStatus = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, undefined);

  const refreshQuota = async (notifyOnError = false) => {
    const ctx = activeContext;
    const model = activeModel;
    if (!ctx || ctx.mode !== "tui") return;
    const currentGeneration = ++generation;
    try {
      const target = await resolveMeridianTarget(ctx, model);
      if (currentGeneration !== generation) return;
      if (!target) {
        clearStatus(ctx);
        return;
      }
      const quota = await fetchMeridianQuota(target);
      if (currentGeneration !== generation) return;
      ctx.ui.setStatus(STATUS_KEY, renderMeridianQuota(quota, ctx.ui.theme));
    } catch (error) {
      if (currentGeneration !== generation) return;
      clearStatus(ctx);
      if (notifyOnError) ctx.ui.notify(errorMessage(error), "error");
    }
  };

  pi.registerCommand("meridian-quota", {
    description: "Refresh Meridian subscription quota",
    async handler(_args, ctx) {
      activeContext = ctx;
      activeModel = ctx.model;
      await refreshQuota(true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeContext = ctx;
    activeModel = ctx.model;
    await refreshQuota(false);
    if (!stopRefresh) {
      const timer = setInterval(() => void refreshQuota(false), REFRESH_MS);
      stopRefresh = () => clearInterval(timer);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    generation++;
    activeContext = ctx;
    activeModel = event.model;
    clearStatus(ctx);
    await refreshQuota(false);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    stopRefresh?.();
    stopRefresh = undefined;
    clearStatus(ctx);
    activeContext = undefined;
    activeModel = undefined;
  });
}
