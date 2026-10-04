import { createElement, Suspense } from "react";
import { LoadingState } from "../../../components/States";
import { getFaceVerifier, type FaceAdapterProps } from "./registry";

/** Renders the registered face client (if any). Defined at module level so the registered component is not "created during render". */
export function FaceVerifierSlot(props: FaceAdapterProps) {
  const registered = getFaceVerifier();
  return registered ? <Suspense fallback={<LoadingState label="Preparing the face check…" />}>{createElement(registered, props)}</Suspense> : null;
}
