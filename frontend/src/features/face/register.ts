import { lazy } from "react";
import { registerEnrolmentPanel } from "../admin/biometrics/adapter";
import { registerFaceVerifier } from "../voter/face/registry";

/**
 * Plugs the real face client into the two seams created for it. Both components are lazy: this file adds only a few lines to the main
 * bundle, and nothing biometric (React components, Human, TensorFlow.js, models) loads until a voter reaches the face screen or an
 * administrator opens enrolment.
 */
registerFaceVerifier(lazy(() => import("./voter/VoterFaceVerifier")));
registerEnrolmentPanel(lazy(() => import("./admin/EnrolmentPanel")));
