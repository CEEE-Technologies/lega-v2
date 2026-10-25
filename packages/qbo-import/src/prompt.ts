import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { join } from "node:path";
import { withLock } from "./storage.js";
import { OAuthTerminalError, type ConnectionStore } from "./auth.js";

export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false });
    child.once("error", () =>
      reject(new Error("Browser could not be opened automatically")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Browser could not be opened automatically")),
    );
  });
}
export async function hiddenCallback(timeoutMs = 600_000): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Manual sign-in requires an interactive terminal; callback URLs must not be supplied in arguments or logs",
    );
  process.stdout.write(
    "Paste the complete redirected URL (hidden), then press Enter: ",
  );
  const input = process.stdin,
    wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const finish = (error?: Error) => {
        clearTimeout(timer);
        input.removeListener("keypress", onKey);
        error ? reject(error) : resolve(value);
      };
      const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
        if ((key?.ctrl && key.name === "c") || key?.name === "escape")
          return finish(new Error("Authorization cancelled"));
        if (key?.name === "return" || key?.name === "enter") return finish();
        if (key?.name === "backspace") value = value.slice(0, -1);
        else if (!key?.ctrl && text) value += text;
        if (value.length > 16_384) finish(new Error("Callback URL too long"));
      };
      const timer = setTimeout(
        () => finish(new Error("Authorization expired; connect again")),
        timeoutMs,
      );
      input.on("keypress", onKey);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stdout.write("\n");
  }
}
export interface BrowserOptions {
  manual?: boolean;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  manualInput?: () => Promise<string>;
  log?: (message: string) => void;
}
export async function connectBrowser(
  store: ConnectionStore,
  options: BrowserOptions = {},
): Promise<void> {
  const log = options.log ?? console.log,
    open = options.openBrowser ?? openBrowser;
  await withLock(join(store.config.stateDir, "signin.lock"), async () => {
    const redirect = new URL(store.config.redirectUri),
      timeout = options.timeoutMs ?? 600_000;
    const show = async (url: string) => {
      log(`Authorize this connection in your browser:\n${url}`);
      try {
        await open(url);
      } catch {
        log("Open the authorization URL above in your browser.");
      }
    };
    if (store.config.environment === "production" || options.manual) {
      const { url } = await store.begin();
      await show(url);
      log(
        "After sign-in, copy the complete callback URL from the address bar. It will be read without echoing.",
      );
      const callback = await (
        options.manualInput ?? (() => hiddenCallback(timeout))
      )();
      await store.complete(callback.trim());
      return;
    }
    let succeed!: () => void, fail!: (error: Error) => void;
    const result = new Promise<void>((resolve, reject) => {
      succeed = resolve;
      fail = reject;
    });
    void result.catch(() => {}); // Listener errors/timeouts can precede browser startup.
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Connection", "close");
      if (
        req.method !== "GET" ||
        !req.url ||
        req.url.split("?")[0] !== redirect.pathname
      ) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      void store.complete(new URL(req.url, redirect.origin).toString()).then(
        () => {
          res.end(
            "QuickBooks connected. You can close this tab and return to the terminal.",
          );
          succeed();
        },
        (error: unknown) => {
          res.writeHead(400);
          res.end(
            "Authorization could not be completed. Retry sign-in from the terminal.",
          );
          if (error instanceof OAuthTerminalError) fail(error);
        },
      );
    });
    const timer = setTimeout(
      () => fail(new Error("Authorization expired; connect again")),
      timeout,
    );
    server.on("error", () =>
      fail(
        new Error(
          "Cannot listen on the configured OAuth callback port; close the other listener or use connect --manual",
        ),
      ),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          Number(redirect.port || 80),
          redirect.hostname.replace(/^\[|\]$/g, ""),
          () => {
            server.removeListener("error", reject);
            resolve();
          },
        );
      });
      const { url } = await store.begin();
      await show(url);
      await result;
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
