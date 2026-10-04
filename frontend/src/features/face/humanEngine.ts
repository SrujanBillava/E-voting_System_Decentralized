import type { Human, Tensor } from "@vladmandic/human";
import { alignmentFor, canvasMatrix, eyeOpenness, landmarks5, yawRatio } from "./align.ts";
import { ASSETS, CROP_SIZE, POSITION } from "./config.ts";
import { DescriptorError, validateDescriptor } from "./descriptor.ts";
import { FaceEngineError, type FaceEngine, type FaceMeasurement, type FrameSource } from "./types.ts";

/**
 * The production engine. Roles (docs/BIOMETRICS.md):
 *   Human (@vladmandic/human): face detection + 468-point mesh -> five landmarks, eye openness, head turn. It also hosts TensorFlow.js.
 *   InsightFace GhostNet (strides 1): the IDENTITY descriptor, 512 numbers, from a 5-point-aligned 112x112 crop (RGB 0..1).
 * Human's own 1024-number embedding is never used. TensorFlow.js runs on the WebAssembly (CPU) backend, which the backend team measured
 * as the more predictable choice; nothing assumes a GPU. All model and wasm files are served by this application (ASSETS).
 *
 * One engine instance is shared; calls are serialised because the WebAssembly backend is single-threaded anyway.
 */
export class HumanGhostNetEngine implements FaceEngine {
  readonly kind = "human-ghostnet" as const;
  /** Timings for the performance report; never sent anywhere. */
  readonly stats: { backend?: string; humanLoadMs?: number; ghostnetLoadMs?: number; lastMeasureMs?: number; lastDescribeMs?: number } = {};
  private human: Human | null = null;
  private model: { execute(input: Tensor): Tensor | Tensor[]; dispose(): void } | null = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  load(): Promise<void> {
    this.loading ??= this.doLoad().catch((err: unknown) => {
      this.loading = null; // a failed load can be retried
      throw err instanceof FaceEngineError ? err : new FaceEngineError("load", "The face recognition files could not be loaded.");
    });
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const t0 = performance.now();
    const { Human } = await import("@vladmandic/human");
    const human = new Human({
      backend: "wasm",
      wasmPath: ASSETS.wasm,
      modelBasePath: ASSETS.humanModels,
      debug: false,
      async: true,
      warmup: "none",
      cacheModels: false, // no IndexedDB model cache: every terminal always runs exactly the files this server serves (no enrol/verify drift after an upgrade)
      cacheSensitivity: 0, // every frame is analysed afresh: a capture must never reuse an earlier frame's landmarks
      filter: { enabled: false },
      face: {
        enabled: true,
        detector: { enabled: true, rotation: false, maxDetected: 3, minConfidence: 0.5 },
        mesh: { enabled: true },
        iris: { enabled: true },
        attention: { enabled: false },
        description: { enabled: false }, // Human's own 1024-number descriptor is NOT used
        emotion: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      segmentation: { enabled: false },
      gesture: { enabled: false },
    });
    await human.init();
    await human.load();
    this.stats.backend = human.tf.getBackend();
    // Human swallows model-load failures (every later describe would then say "no face"): insist the three detectors really loaded.
    const loaded = human.models.loaded();
    if (!["blazeface", "facemesh", "iris"].every((m) => loaded.includes(m))) throw new FaceEngineError("load", "The face detection files could not be loaded.");
    this.stats.humanLoadMs = Math.round(performance.now() - t0);

    const t1 = performance.now();
    const model = await human.tf.loadGraphModel(ASSETS.ghostnet);
    this.model = model as unknown as NonNullable<typeof this.model>;
    this.human = human;
    this.stats.ghostnetLoadMs = Math.round(performance.now() - t1);
    // Compile the model once so the first real capture is not the slow one.
    await this.runModel(human.tf.zeros([1, CROP_SIZE, CROP_SIZE, 3]) as Tensor);
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runModel(input: Tensor): Promise<number[]> {
    const tf = this.human!.tf;
    const raw = this.model!.execute(input);
    const out = Array.isArray(raw) ? raw[0] : raw;
    const data = await out.data();
    tf.dispose([input, ...(Array.isArray(raw) ? raw : [raw])]);
    return Array.from(data as Float32Array);
  }

  /** A private copy of the current frame, so detection and cropping use exactly the same pixels. */
  private snapshot(source: FrameSource): HTMLCanvasElement {
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height;
    if (!width || !height) throw new FaceEngineError("no-face", "The camera frame is not ready.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(source, 0, 0, width, height); // never mirrored
    return canvas;
  }

  private async analyse(frame: HTMLCanvasElement): Promise<FaceMeasurement> {
    const human = this.human;
    if (!human) throw new FaceEngineError("load", "The face engine is not loaded.");
    const result = await human.detect(frame);
    const { width, height } = frame;
    const found = result.face.filter((f) => f.box[3] / height >= POSITION.ignoreFacesBelowHeightRatio);
    const measurement: FaceMeasurement = { faceCount: found.length, frame: { width, height } };
    if (found.length !== 1) return measurement;
    const f = found[0];
    const mesh = f.mesh as unknown as readonly (readonly number[])[] | undefined;
    if (!mesh || mesh.length < 468) return measurement; // face seen but no usable landmarks: callers treat it as "not clear"
    const points = landmarks5(mesh);
    measurement.face = { box: { x: f.box[0], y: f.box[1], width: f.box[2], height: f.box[3] }, eyeOpenness: eyeOpenness(mesh), yawRatio: yawRatio(points), landmarks5: points };
    return measurement;
  }

  measure(source: FrameSource): Promise<FaceMeasurement> {
    return this.serial(async () => {
      const t = performance.now();
      const m = await this.analyse(this.snapshot(source));
      this.stats.lastMeasureMs = Math.round(performance.now() - t);
      return m;
    });
  }

  describe(source: FrameSource): Promise<{ descriptor: number[]; measurement: FaceMeasurement }> {
    return this.serial(async () => {
      const t = performance.now();
      const frame = this.snapshot(source);
      const measurement = await this.analyse(frame);
      if (measurement.faceCount === 0) throw new FaceEngineError("no-face", "No face was found.");
      if (measurement.faceCount > 1) throw new FaceEngineError("many-faces", "More than one face was found.");
      if (!measurement.face) throw new FaceEngineError("no-face", "The face landmarks were not clear.");

      // Straighten and crop: one similarity transform maps the five landmarks onto the template, the frame is drawn through it.
      const crop = document.createElement("canvas");
      crop.width = CROP_SIZE;
      crop.height = CROP_SIZE;
      const ctx = crop.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(...canvasMatrix(alignmentFor(measurement.face.landmarks5)));
      ctx.drawImage(frame, 0, 0);

      const tf = this.human!.tf;
      const input = tf.tidy(() => tf.div(tf.expandDims(tf.cast(tf.browser.fromPixels(crop), "float32"), 0), 255)) as Tensor;
      let descriptor: number[];
      try {
        descriptor = validateDescriptor(await this.runModel(input));
      } catch (err) {
        throw err instanceof DescriptorError ? new FaceEngineError("invalid-descriptor", "The face descriptor was not valid.") : new FaceEngineError("inference", "The face could not be analysed.");
      }
      this.stats.lastDescribeMs = Math.round(performance.now() - t);
      return { descriptor, measurement };
    });
  }

  dispose(): void {
    this.model?.dispose();
    this.model = null;
    this.human = null;
    this.loading = null;
  }
}
