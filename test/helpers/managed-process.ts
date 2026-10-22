export async function until<T>(
  read: () => Promise<T | undefined>,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw Error("PROCESS_PROBE_TIMEOUT");
}
export function launch(entry: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const events: Record<string, unknown>[] = [];
  const errors = new Response(child.stderr).text();
  const output = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* Framework startup text. */
        }
      }
    }
  })();
  return {
    child,
    events,
    async port(event: string) {
      return until(async () => {
        if (child.exitCode !== null)
          throw Error("PROCESS_EXITED: " + (await errors));
        const ready = events.find((e) => e.event === event);
        return typeof ready?.port === "number" ? ready.port : undefined;
      });
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await output;
      await errors;
    },
  };
}
