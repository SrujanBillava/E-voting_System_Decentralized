/** Starts loading the face engine in the background (for example right after a successful voter password login). Errors are ignored here: the face screen reports them. */
export function prefetchFaceEngine(): void {
  void import("./engine.ts").then((m) => m.getFaceEngine()).catch(() => undefined);
}
