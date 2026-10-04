import type { BrowserContext, Page } from "@playwright/test";
import { fixture } from "./helpers";

/**
 * Browser-test helpers for the face flow. The browser runs the TEST-ONLY face engine (window.__E2E_FACE__, compiled in only when the
 * dev server / build is started with VITE_E2E_FACE=1). Descriptors are made-up numbers from the backend's synthetic-person generator
 * (backend-api/test/helpers/face.js, reached through the fixture CLI): no real person's face is involved anywhere.
 */
export interface FaceScript {
  faces?: number;
  descriptor?: number[];
  failLoad?: boolean;
  describeError?: "no-face" | "many-faces" | "inference";
  noMovement?: boolean;
  loadMs?: number;
}

/** A synthetic capture of imaginary person `seed`: cosine similarity `similarity` to that person's true face. */
export const capture = (seed: number, similarity = 0.85, variant = 60): number[] => fixture<{ descriptor: number[] }>("descriptor", String(seed), String(similarity), String(variant)).descriptor;
/** Synthetic enrolment samples (cosine ~0.9 to the true face) of imaginary person `seed`. */
export const samples = (seed: number, count = 3): number[][] => fixture<{ samples: number[][] }>("samples", String(seed), String(count)).samples;

/** Installed before any page script runs, and kept across reloads. */
export async function installFace(target: BrowserContext | Page, script: FaceScript = {}) {
  await target.addInitScript((s) => {
    (window as unknown as { __E2E_FACE__: unknown }).__E2E_FACE__ = { ...s };
    // Record every camera stream, so tests can prove every track is stopped.
    const md = navigator.mediaDevices;
    if (md && !(md as unknown as { __wrapped?: boolean }).__wrapped) {
      const original = md.getUserMedia.bind(md);
      (window as unknown as { __streams: MediaStream[] }).__streams = [];
      md.getUserMedia = async (c) => {
        const stream = await original(c);
        (window as unknown as { __streams: MediaStream[] }).__streams.push(stream);
        return stream;
      };
      (md as unknown as { __wrapped: boolean }).__wrapped = true;
    }
  }, script);
}

/** Change what the fake person/engine does, on the current document. */
export const setFace = (page: Page, patch: FaceScript) => page.evaluate((p) => Object.assign((window as unknown as { __E2E_FACE__: object }).__E2E_FACE__ ?? ((window as unknown as { __E2E_FACE__: object }).__E2E_FACE__ = {}), p), patch);

/** How many camera tracks are still live right now (0 = the camera light is off). */
export const liveTracks = (page: Page) => page.evaluate(() => ((window as unknown as { __streams?: MediaStream[] }).__streams ?? []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);
/** How many camera streams were ever opened on this document. */
export const streamsOpened = (page: Page) => page.evaluate(() => (window as unknown as { __streams?: MediaStream[] }).__streams?.length ?? 0);
