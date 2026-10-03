import type { ComponentType } from "react";

/**
 * The seam where the real face-enrolment panel plugs into the admin console once feature/biometrics is merged.
 *
 * Nothing in this module enrols anyone. The Biometrics page renders the registered component inside a dialog; that component
 * talks to ITS OWN backend endpoints and the SERVER decides whether the voter is enrolled. The panel only tells the page
 * "ask the server again" through `onEnrolmentChanged` (the page then re-reads the voter list, the single source of truth).
 * Until a panel is registered the page keeps its enrol actions disabled, with an explanation.
 */
export interface EnrolmentPanelProps {
  voter: { id: string; voterId: string; name: string; faceEnrolled: boolean };
  /** Call after the biometric client's own backend call finished (success or failure). The page re-reads the voters. */
  onEnrolmentChanged: () => void;
  /** Ask the page to close the dialog. */
  onClose: () => void;
}

let registered: ComponentType<EnrolmentPanelProps> | null = null;

/** Called once at startup by the biometric integration (not by this step). Pass null to unregister. */
export function registerEnrolmentPanel(component: ComponentType<EnrolmentPanelProps> | null): void {
  registered = component;
}
export const getEnrolmentPanel = (): ComponentType<EnrolmentPanelProps> | null => registered;
