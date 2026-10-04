export type CameraErrorKind = "denied" | "no-device" | "in-use" | "insecure" | "unsupported" | "unknown";

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.name = "CameraError";
    this.kind = kind;
  }
}

function classify(err: unknown): CameraError {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return new CameraError("denied", "Camera permission was refused.");
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return new CameraError("no-device", "No camera was found.");
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return new CameraError("in-use", "The camera is busy or cannot be read.");
  return new CameraError("unknown", "The camera could not be started.");
}

/**
 * One camera session. It owns the MediaStream and guarantees that stop() ends EVERY track, so the camera light goes out. start() and
 * stop() may race (React StrictMode, a quick Cancel): a stream that arrives after stop() was called is stopped immediately.
 */
export class CameraSession {
  private stream: MediaStream | null = null;
  private generation = 0;

  get active(): boolean {
    return this.stream?.getTracks().some((t) => t.readyState === "live") ?? false;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    if (!window.isSecureContext) throw new CameraError("insecure", "The camera needs a secure (HTTPS or localhost) page.");
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("unsupported", "This browser cannot use a camera.");
    this.stop();
    const mine = ++this.generation;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (err) {
      throw classify(err);
    }
    if (mine !== this.generation) {
      stream.getTracks().forEach((t) => t.stop()); // stop() was called while the permission prompt was open
      throw new CameraError("unknown", "The camera was closed before it started.");
    }
    this.stream = stream;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
      if (mine === this.generation && video.videoWidth === 0) await new Promise<void>((r) => video.addEventListener("loadedmetadata", () => r(), { once: true }));
    } catch {
      this.stop();
      throw new CameraError("in-use", "The camera could not be read.");
    }
  }

  stop(): void {
    this.generation++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
