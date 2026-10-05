import type { RefObject } from "react";

/**
 * The live preview with the face-position guide. The preview is mirrored for the person looking at it (like a mirror); the frames the
 * engine analyses and describes are always the unmirrored camera frames. The video element is always rendered so the camera hook can attach
 * a stream to it.
 */
export function FaceCameraView({ videoRef, live }: { videoRef: RefObject<HTMLVideoElement | null>; live: boolean }) {
  return (
    <div className="camera-shell" role="img" aria-label="Camera preview with a guide for your face">
      <video ref={videoRef} className="camera-video" muted playsInline aria-hidden="true" />
      {live && (
        <svg className="camera-guide" viewBox="0 0 120 150" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <ellipse cx="60" cy="72" rx="38" ry="52" stroke="var(--c-ink)" strokeWidth="5" opacity="0.55" />
          <ellipse cx="60" cy="72" rx="38" ry="52" stroke="var(--c-surface)" strokeDasharray="8 6" />
        </svg>
      )}
    </div>
  );
}
