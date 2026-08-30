import { useEffect, useRef, useState } from "react";

/** "You" PiP (spec §19). Video only; frames are not sent anywhere unless a vision provider is wired. */
export function SelfCamera({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false })
      .then((s) => {
        stream = s;
        if (ref.current) ref.current.srcObject = s;
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "camera unavailable"));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [enabled]);
  if (!enabled) return null;
  return (
    <div className="pip">
      {error ? <div className="pip__off">{error}</div> : <video ref={ref} autoPlay playsInline muted />}
      <span className="pip__label">あなた</span>
    </div>
  );
}
