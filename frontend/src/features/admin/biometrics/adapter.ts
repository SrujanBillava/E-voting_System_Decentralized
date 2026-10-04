import type { ComponentType, LazyExoticComponent } from "react";

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
  /** True only while the election is in Setup: enrolment changes are refused by the server in every other phase. */
  canModify: boolean;
  /** Tell the page an enrolment request is in flight, so it does not let the dialog be dismissed meanwhile. */
  onBusyChange: (busy: boolean) => void;
}
type PanelComponent = ComponentType<EnrolmentPanelProps> | LazyExoticComponent<ComponentType<EnrolmentPanelProps>>;

let registered: PanelComponent | null = null;

/** Called once at startup by the biometric integration (not by this step). Pass null to unregister. */
export function registerEnrolmentPanel(component: PanelComponent | null): void {
  registered = component;
}
export const getEnrolmentPanel = (): PanelComponent | null => registered;
