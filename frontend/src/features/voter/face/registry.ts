import type { ComponentType, LazyExoticComponent } from "react";

/**
 * The seam where the real face-verification client plugs in once feature/biometrics is merged.
 *
 * Nothing in this module verifies anything. The kiosk renders the registered component inside the face screen; that component
 * (the biometric client) talks to ITS backend endpoints, and the SERVER moves the session AUTHENTICATED -> FACE_VERIFIED.
 * The component only tells the kiosk "ask the server again" by calling `onServerStageMayHaveChanged`; the kiosk then re-reads
 * GET /voter/status, which is the single source of truth. There is deliberately no way to report success from the browser.
 */
export interface FaceAdapterProps {
  voter: { name: string; voterId: string };
  /** Call after the biometric client's own backend call finished (success OR failure). The kiosk re-reads the server stage. */
  onServerStageMayHaveChanged: () => void;
  /** Ask for an official (e.g. repeated failures). The kiosk shows its assistance state. */
  onNeedsOfficial: () => void;
}

type FaceComponent = ComponentType<FaceAdapterProps> | LazyExoticComponent<ComponentType<FaceAdapterProps>>;
let registered: FaceComponent | null = null;

/** Called once at startup by the biometric integration (not by this step). */
export function registerFaceVerifier(component: FaceComponent | null): void {
  registered = component;
}
export const getFaceVerifier = (): FaceComponent | null => registered;
export const hasFaceVerifier = (): boolean => registered !== null;
