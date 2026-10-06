let wait: (milliseconds: number) => Promise<unknown> = (milliseconds) => Bun.sleep(milliseconds);

/** The sync worker installs its pause/stop gate; API requests keep normal waits. */
export function setProviderWait(next: typeof wait): void {
  wait = next;
}

export function waitForProvider(milliseconds: number): Promise<unknown> {
  return wait(milliseconds);
}
