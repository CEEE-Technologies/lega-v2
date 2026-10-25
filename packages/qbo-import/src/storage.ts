import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}

export async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

async function recoverDeadLock(path: string): Promise<void> {
  const recovery = `${path}.recovery`;
  try {
    await mkdir(recovery, { mode: 0o700 });
  } catch (e) {
    if (code(e) === "EEXIST") return;
    throw e;
  }
  try {
    // A malformed/ownerless lock may be a process still writing its identity.
    // Never guess it is stale. Operator can inspect/remove it after a crash.
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const owner = (await jsonFile(join(path, "owner.json"))) as {
      pid?: number;
      hostname?: string;
    };
    if (
      owner.hostname !== hostname() ||
      !Number.isInteger(owner.pid) ||
      owner.pid! < 1
    )
      return;
    try {
      process.kill(owner.pid!, 0);
    } catch (e) {
      if (code(e) === "ESRCH") await rm(path, { recursive: true });
    }
  } catch (e) {
    if (
      !["ENOENT", "ENOTDIR"].includes(code(e) ?? "") &&
      !(e instanceof SyntaxError)
    )
      throw e;
  } finally {
    await rm(recovery, { recursive: true, force: true });
  }
}

export async function withLock<T>(
  path: string,
  work: () => Promise<T>,
  waitMs = 0,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (e) {
      if (code(e) !== "EEXIST") throw e;
      await recoverDeadLock(path);
      try {
        await lstat(path);
      } catch (e) {
        if (code(e) === "ENOENT") continue;
        throw e;
      }
      if (Date.now() >= deadline)
        throw new Error(
          "Resource is locked by another process. Retry after it finishes; inspect an ownerless lock before removing it.",
        );
      await delay(50);
    }
  }
  const id = randomUUID();
  try {
    await atomicJson(join(path, "owner.json"), {
      pid: process.pid,
      hostname: hostname(),
      id,
    });
    return await work();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
