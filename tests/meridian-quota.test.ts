import { afterEach, describe, expect, it } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import meridianQuotaExtension, {
  parseMeridianQuota,
  renderMeridianQuota,
} from "../extensions/meridian-quota";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface Harness {
  handlers: Map<string, EventHandler>;
  commands: Map<string, CommandHandler>;
}

interface ContextOptions {
  mode?: "tui" | "rpc" | "json" | "print";
  oauth?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
}

function createHarness(): Harness {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const pi = {
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
  } as unknown as ExtensionAPI;
  meridianQuotaExtension(pi);
  return { handlers, commands };
}

function createContext(options: ContextOptions = {}) {
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let authCalls = 0;
  const model = {
    provider: "anthropic",
    id: "claude-opus-5",
    baseUrl: options.baseUrl ?? "http://localhost:3456/api",
  };
  const context = {
    mode: options.mode ?? "tui",
    model,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
    modelRegistry: {
      isUsingOAuth: () => options.oauth ?? false,
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return {
          ok: true,
          apiKey: "unused-placeholder",
          baseUrl: options.baseUrl,
          headers: options.headers ?? { "x-meridian-agent": "pi" },
        };
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    context,
    model,
    statuses,
    notifications,
    authCalls: () => authCalls,
  };
}

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("quota parsing and rendering", () => {
  it("parses the supported windows and ignores model-specific buckets", () => {
    expect(parseMeridianQuota({
      buckets: [
        { type: "five_hour", utilization: "0.24", resetsAt: "1786313400359" },
        { type: "seven_day", utilization: 0.71, resetsAt: 1786453200359 },
        { type: "seven_day_fable", utilization: 0.12, resetsAt: null },
      ],
    })).toEqual({
      fiveHour: { utilization: 0.24, resetsAt: 1786313400359 },
      sevenDay: { utilization: 0.71, resetsAt: 1786453200359 },
    });
  });

  it("rejects unusable Meridian responses", () => {
    expect(() => parseMeridianQuota({ buckets: [] })).toThrow("no five-hour or seven-day buckets");
    expect(() => parseMeridianQuota({
      buckets: [{ type: "five_hour", utilization: 1.01 }],
    })).toThrow("invalid utilization");
    expect(() => parseMeridianQuota(null)).toThrow("Invalid Meridian quota response");
  });

  it("renders bars, percentages, and reset countdowns", () => {
    const now = Date.UTC(2026, 7, 9, 12);
    const theme = { fg: (_color: string, text: string) => text } as ExtensionContext["ui"]["theme"];
    expect(renderMeridianQuota({
      fiveHour: { utilization: 0.24, resetsAt: now + 90 * 60_000 },
      sevenDay: { utilization: 0.71, resetsAt: now + 2 * 24 * 60 * 60_000 },
    }, theme, now)).toBe(
      "Meridian 5h ██░░░░░░ 24% ⟳ 2h 7d ██████░░ 71% ⟳ 2d",
    );
  });
});

describe("extension lifecycle", () => {
  it("fetches Meridian quota and starts one TUI refresh timer", async () => {
    let requestUrl = "";
    let requestAgent = "";
    let intervalCalls = 0;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestAgent = new Headers(init?.headers).get("x-meridian-agent") ?? "";
      return new Response(JSON.stringify({
        buckets: [
          { type: "five_hour", utilization: 0.03, resetsAt: Date.now() + 60_000 },
          { type: "seven_day", utilization: 0.31, resetsAt: Date.now() + 86_400_000 },
        ],
      }), { status: 200 });
    }) as typeof fetch;
    globalThis.setInterval = ((_handler: TimerHandler, _timeout?: number) => {
      intervalCalls++;
      return 1;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => undefined) as typeof clearInterval;

    const harness = createHarness();
    const mock = createContext({
      baseUrl: "http://localhost:3456/api",
      headers: { "X-Meridian-Agent": "pi" },
    });
    await harness.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      mock.context,
    );

    expect(requestUrl).toBe("http://localhost:3456/v1/usage/quota");
    expect(requestAgent).toBe("pi");
    expect(mock.statuses.at(-1)?.key).toBe("meridian-quota");
    expect(mock.statuses.at(-1)?.value).toContain("Meridian 5h");
    expect(intervalCalls).toBe(1);

    await harness.handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      mock.context,
    );
  });

  it("does not fetch or create timers outside TUI mode", async () => {
    let fetchCalls = 0;
    let intervalCalls = 0;
    globalThis.fetch = (async (_input) => {
      fetchCalls++;
      return new Response("{}");
    }) as typeof fetch;
    globalThis.setInterval = ((_handler: TimerHandler, _timeout?: number) => {
      intervalCalls++;
      return 1;
    }) as typeof setInterval;

    const harness = createHarness();
    const mock = createContext({ mode: "print" });
    await harness.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      mock.context,
    );

    expect(fetchCalls).toBe(0);
    expect(intervalCalls).toBe(0);
    expect(mock.authCalls()).toBe(0);
  });

  it("stays inactive for direct Anthropic OAuth", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (_input) => {
      fetchCalls++;
      return new Response("{}");
    }) as typeof fetch;
    globalThis.setInterval = ((_handler: TimerHandler, _timeout?: number) => 1) as typeof setInterval;
    globalThis.clearInterval = (() => undefined) as typeof clearInterval;

    const harness = createHarness();
    const mock = createContext({ oauth: true });
    await harness.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      mock.context,
    );

    expect(fetchCalls).toBe(0);
    expect(mock.authCalls()).toBe(0);
    expect(mock.statuses.at(-1)).toEqual({ key: "meridian-quota", value: undefined });

    await harness.handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      mock.context,
    );
  });

  it("reports HTTP errors when the command forces a refresh", async () => {
    globalThis.fetch = (async (_input) => new Response("unavailable", { status: 503 })) as typeof fetch;

    const harness = createHarness();
    const mock = createContext();
    await harness.commands.get("meridian-quota")?.("", mock.context);

    expect(mock.notifications).toEqual([{
      message: "Meridian quota request failed with HTTP 503",
      level: "error",
    }]);
    expect(mock.statuses.at(-1)).toEqual({ key: "meridian-quota", value: undefined });
  });
});
