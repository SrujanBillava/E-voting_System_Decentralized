import { createElement } from "react";
import { getFaceVerifier, type FaceAdapterProps } from "./registry";

/** Renders the registered client (if any). Defined at module level so the registered component is not "created during render". */
export function FaceVerifierSlot(props: FaceAdapterProps) {
  const registered = getFaceVerifier();
  return registered ? createElement(registered, props) : null;
}
