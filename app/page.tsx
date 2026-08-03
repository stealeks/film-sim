"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "request" | "live" | "developing" | "result" | "error";
type FacingMode = "environment" | "user";
type StockId = "gold-200" | "tx400";
type MeteringAvailability = "checking" | "hardware" | "software";
type MeteringStatus = "idle" | "focusing" | "hardware" | "software";

type MeterPoint = {
  viewX: number;
  viewY: number;
  sensorX: number;
  sensorY: number;
};

type NumericCapability = {
  min: number;
  max: number;
  step: number;
};

type CameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  exposureMode?: string[];
  exposureCompensation?: NumericCapability;
};

type CameraConstraintSet = MediaTrackConstraintSet & {
  focusMode?: string;
  exposureMode?: string;
  pointsOfInterest?: Array<{ x: number; y: number }>;
  exposureCompensation?: number;
};

type CameraSupportedConstraints = MediaTrackSupportedConstraints & {
  pointsOfInterest?: boolean;
};

type CaptureMeta = {
  source: "photo" | "video";
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  elapsedMs: number;
};

type WorkerResult = {
  type: "developed" | "error";
  id: string;
  buffer?: ArrayBuffer;
  message?: string;
};

type ImageCaptureLike = {
  takePhoto: () => Promise<Blob>;
};

type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike;

const STOCKS: Array<{
  id: StockId;
  name: string;
  note: string;
  iso: number;
}> = [
  { id: "gold-200", name: "Kodak Gold 200", note: "C-41 · warm, saturated", iso: 200 },
  { id: "tx400", name: "Kodak TX400", note: "TRI-X · D-76", iso: 400 },
];

const waitForPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function cropToAspect(width: number, height: number, aspect: number) {
  const sourceAspect = width / height;
  if (sourceAspect > aspect) {
    const cropWidth = height * aspect;
    return { x: (width - cropWidth) / 2, y: 0, width: cropWidth, height };
  }
  const cropHeight = width / aspect;
  return { x: 0, y: (height - cropHeight) / 2, width, height: cropHeight };
}

function megapixels(width: number, height: number) {
  return `${(width * height / 1_000_000).toFixed(1)} MP`;
}

function signedStops(value: number) {
  if (Math.abs(value) < 0.05) return "0.0";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function chooseMeteringMode(modes: string[] | undefined) {
  if (modes?.includes("single-shot")) return "single-shot";
  if (modes?.includes("continuous")) return "continuous";
  return undefined;
}

function getCameraSupportedConstraints(): CameraSupportedConstraints {
  if (typeof navigator === "undefined" ||
      typeof navigator.mediaDevices?.getSupportedConstraints !== "function") {
    return {};
  }
  return navigator.mediaDevices.getSupportedConstraints() as CameraSupportedConstraints;
}

function viewPointToSensor(
  video: HTMLVideoElement,
  viewX: number,
  viewY: number,
  frameWidth: number,
  frameHeight: number,
  mirrored: boolean,
): MeterPoint {
  const normalizedViewX = clampNumber(viewX, 0, 1);
  const normalizedViewY = clampNumber(viewY, 0, 1);
  const videoWidth = video.videoWidth || frameWidth;
  const videoHeight = video.videoHeight || frameHeight;
  const scale = Math.max(frameWidth / videoWidth, frameHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const cropX = Math.max(0, (renderedWidth - frameWidth) / 2);
  const cropY = Math.max(0, (renderedHeight - frameHeight) / 2);
  let sensorX = (normalizedViewX * frameWidth + cropX) / renderedWidth;
  const sensorY = (normalizedViewY * frameHeight + cropY) / renderedHeight;
  if (mirrored) sensorX = 1 - sensorX;

  return {
    viewX: normalizedViewX,
    viewY: normalizedViewY,
    sensorX: clampNumber(sensorX, 0, 1),
    sensorY: clampNumber(sensorY, 0, 1),
  };
}

function estimateSpotExposure(video: HTMLVideoElement, point: MeterPoint) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return 0;

  const radius = Math.max(12, Math.min(video.videoWidth, video.videoHeight) * 0.07);
  const sampleWidth = Math.min(video.videoWidth, radius * 2);
  const sampleHeight = Math.min(video.videoHeight, radius * 2);
  const sourceX = clampNumber(
    point.sensorX * video.videoWidth - sampleWidth / 2,
    0,
    video.videoWidth - sampleWidth,
  );
  const sourceY = clampNumber(
    point.sensorY * video.videoHeight - sampleHeight / 2,
    0,
    video.videoHeight - sampleHeight,
  );
  const sample = document.createElement("canvas");
  sample.width = 32;
  sample.height = 32;
  const context = sample.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return 0;
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sampleWidth,
    sampleHeight,
    0,
    0,
    sample.width,
    sample.height,
  );

  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  let logLuminance = 0;
  let samples = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const toLinear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    const luminance =
      0.2126 * toLinear(pixels[index]) +
      0.7152 * toLinear(pixels[index + 1]) +
      0.0722 * toLinear(pixels[index + 2]);
    logLuminance += Math.log(0.0001 + luminance);
    samples += 1;
  }

  const average = Math.exp(logLuminance / Math.max(1, samples)) - 0.0001;
  const correction = Math.log2(0.18 / clampNumber(average, 0.018, 0.82)) * 0.7;
  return Math.round(clampNumber(correction, -1.35, 1.35) * 10) / 10;
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not create JPEG"))),
      "image/jpeg",
      0.96,
    );
  });
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const resultBlobRef = useRef<Blob | null>(null);
  const baseTrackConstraintsRef = useRef<MediaTrackConstraints | null>(null);
  const cameraCapabilitiesRef = useRef<CameraCapabilities>({});
  const meterRequestRef = useRef(0);
  const biasTimerRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("request");
  const [facing, setFacing] = useState<FacingMode>("environment");
  const [stockId, setStockId] = useState<StockId>("gold-200");
  const [exposure, setExposure] = useState(0);
  const [grain, setGrain] = useState(100);
  const [halation, setHalation] = useState(100);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [message, setMessage] = useState("");
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [meterPoint, setMeterPoint] = useState<MeterPoint | null>(null);
  const [meteringAvailability, setMeteringAvailability] =
    useState<MeteringAvailability>("checking");
  const [meteringStatus, setMeteringStatus] = useState<MeteringStatus>("idle");
  const [softwareMeterExposure, setSoftwareMeterExposure] = useState(0);
  const [meterBias, setMeterBias] = useState(0);
  const [meterBiasRange, setMeterBiasRange] = useState({ min: -1.5, max: 1.5, step: 0.1 });
  const [hardwareMeterActive, setHardwareMeterActive] = useState(false);
  const [hardwareAppliedBias, setHardwareAppliedBias] = useState(0);

  const stopCamera = useCallback(() => {
    meterRequestRef.current += 1;
    if (biasTimerRef.current !== null) {
      window.clearTimeout(biasTimerRef.current);
      biasTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    baseTrackConstraintsRef.current = null;
    cameraCapabilitiesRef.current = {};
  }, []);

  const startCamera = useCallback(
    async (mode: FacingMode) => {
      stopCamera();
      setMessage("");
      setPhase("request");
      setMeterPoint(null);
      setMeteringAvailability("checking");
      setMeteringStatus("idle");
      setSoftwareMeterExposure(0);
      setMeterBias(0);
      setMeterBiasRange({ min: -1.5, max: 1.5, step: 0.1 });
      setHardwareMeterActive(false);
      setHardwareAppliedBias(0);

      if (!navigator.mediaDevices?.getUserMedia) {
        setMessage("This browser does not provide camera access.");
        setPhase("error");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: mode },
            width: { ideal: 4096 },
            height: { ideal: 3072 },
          },
        });
        streamRef.current = stream;
        const [track] = stream.getVideoTracks();
        if (track) {
          baseTrackConstraintsRef.current = track.getConstraints();
          try {
            cameraCapabilitiesRef.current = track.getCapabilities() as CameraCapabilities;
          } catch {
            cameraCapabilitiesRef.current = {};
          }
          const supported = getCameraSupportedConstraints();
          setMeteringAvailability(supported.pointsOfInterest ? "hardware" : "software");

          const compensation = cameraCapabilitiesRef.current.exposureCompensation;
          if (compensation && Number.isFinite(compensation.min) && Number.isFinite(compensation.max)) {
            const minimum = Math.max(-2, compensation.min);
            const maximum = Math.min(2, compensation.max);
            if (maximum > minimum) {
              setMeterBiasRange({
                min: minimum,
                max: maximum,
                step: Math.max(0.1, compensation.step || 0.1),
              });
            }
          } else {
            setMeterBiasRange({ min: -1.5, max: 1.5, step: 0.1 });
          }
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setPhase("live");
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Camera access was denied";
        setMessage(detail);
        setPhase("error");
      }
    },
    [stopCamera],
  );

  useEffect(() => {
    const startup = window.setTimeout(() => void startCamera("environment"), 0);
    return () => {
      window.clearTimeout(startup);
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  async function switchCamera() {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    await startCamera(next);
  }

  async function applyHardwareMetering(
    point: MeterPoint,
    bias: number,
    triggerFocus: boolean,
  ) {
    const [track] = streamRef.current?.getVideoTracks() ?? [];
    const supported = getCameraSupportedConstraints();
    if (!track || track.readyState !== "live" || !supported.pointsOfInterest) {
      return { pointApplied: false, appliedBias: 0 };
    }

    const capabilities = cameraCapabilitiesRef.current;
    const controls: CameraConstraintSet = {
      pointsOfInterest: [{ x: point.sensorX, y: point.sensorY }],
    };
    if (triggerFocus) {
      const focusMode = chooseMeteringMode(capabilities.focusMode);
      if (focusMode) controls.focusMode = focusMode;
    }
    const exposureMode = chooseMeteringMode(capabilities.exposureMode);
    if (exposureMode) controls.exposureMode = exposureMode;

    let appliedBias = 0;
    const compensation = capabilities.exposureCompensation;
    if (compensation && compensation.max > compensation.min) {
      const clampedBias = clampNumber(bias, compensation.min, compensation.max);
      const step = compensation.step || 0.1;
      appliedBias =
        compensation.min + Math.round((clampedBias - compensation.min) / step) * step;
      controls.exposureCompensation = appliedBias;
    }

    const baseConstraints = baseTrackConstraintsRef.current ?? track.getConstraints();
    await track.applyConstraints({
      ...baseConstraints,
      advanced: [controls],
    } as MediaTrackConstraints);
    return { pointApplied: true, appliedBias };
  }

  async function meterAtPoint(point: MeterPoint) {
    const video = videoRef.current;
    if (!video || phase !== "live") return;

    const requestId = ++meterRequestRef.current;
    setMeterPoint(point);
    setMeteringStatus("focusing");
    setSoftwareMeterExposure(0);

    try {
      const result = await applyHardwareMetering(point, meterBias, true);
      if (requestId !== meterRequestRef.current) return;
      if (result.pointApplied) {
        setHardwareMeterActive(true);
        setHardwareAppliedBias(result.appliedBias);
        setMeteringAvailability("hardware");
        setMeteringStatus("hardware");
        return;
      }
    } catch {
      // Fall through to the software spot meter when the device rejects camera controls.
    }

    if (requestId !== meterRequestRef.current) return;
    setHardwareMeterActive(false);
    setHardwareAppliedBias(0);
    setMeteringAvailability("software");
    setSoftwareMeterExposure(estimateSpotExposure(video, point));
    setMeteringStatus("software");
  }

  function meterFromViewPoint(viewX: number, viewY: number, width: number, height: number) {
    const video = videoRef.current;
    if (!video || phase !== "live") return;
    const point = viewPointToSensor(
      video,
      viewX,
      viewY,
      width,
      height,
      facing === "user",
    );
    void meterAtPoint(point);
  }

  function changeMeterBias(nextValue: number) {
    const next = clampNumber(nextValue, meterBiasRange.min, meterBiasRange.max);
    setMeterBias(next);
    if (!hardwareMeterActive || !meterPoint) {
      return;
    }

    if (biasTimerRef.current !== null) window.clearTimeout(biasTimerRef.current);
    biasTimerRef.current = window.setTimeout(() => {
      biasTimerRef.current = null;
      void applyHardwareMetering(meterPoint, next, false)
        .then((result) => setHardwareAppliedBias(result.appliedBias))
        .catch(() => undefined);
    }, 120);
  }

  function processInWorker(
    imageData: ImageData,
    options: {
      width: number;
      height: number;
      stockId: StockId;
      exposure: number;
      grain: number;
      halation: number;
      seed: number;
    },
  ) {
    return new Promise<Uint8ClampedArray>((resolve, reject) => {
      const worker = new Worker("/film-worker.js");
      const id = `${Date.now()}-${Math.random()}`;
      const timeout = window.setTimeout(() => {
        worker.terminate();
        reject(new Error("Development took too long"));
      }, 90_000);

      worker.onmessage = (event: MessageEvent<WorkerResult>) => {
        if (event.data.id !== id) return;
        window.clearTimeout(timeout);
        worker.terminate();
        if (event.data.type === "error" || !event.data.buffer) {
          reject(new Error(event.data.message || "Development failed"));
          return;
        }
        resolve(new Uint8ClampedArray(event.data.buffer));
      };
      worker.onerror = () => {
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error("The development engine did not start"));
      };

      const buffer = imageData.data.buffer as ArrayBuffer;
      worker.postMessage({ type: "develop", id, buffer, ...options }, [buffer]);
    });
  }

  async function takePicture() {
    const video = videoRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const resultCanvas = resultCanvasRef.current;
    const stream = streamRef.current;
    if (!video || !sourceCanvas || !resultCanvas || !stream || phase !== "live") return;

    setSettingsOpen(false);
    setComparing(false);
    setPhase("developing");
    setMessage("");
    resultBlobRef.current = null;
    await waitForPaint();

    const startedAt = performance.now();
    let bitmap: ImageBitmap | null = null;
    let source: CanvasImageSource = video;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;
    let sourceType: CaptureMeta["source"] = "video";

    try {
      const [track] = stream.getVideoTracks();
      const ImageCaptureApi = (
        window as typeof window & { ImageCapture?: ImageCaptureConstructor }
      ).ImageCapture;

      if (track && ImageCaptureApi) {
        try {
          const photo = await new ImageCaptureApi(track).takePhoto();
          bitmap = await createImageBitmap(photo);
          source = bitmap;
          sourceWidth = bitmap.width;
          sourceHeight = bitmap.height;
          sourceType = "photo";
        } catch {
          source = video;
        }
      }

      if (!sourceWidth || !sourceHeight) throw new Error("The camera is not ready yet");

      const frame = frameRef.current;
      const frameAspect = frame && frame.clientHeight
        ? frame.clientWidth / frame.clientHeight
        : window.innerWidth > window.innerHeight
          ? 3 / 2
          : 2 / 3;
      const crop = cropToAspect(sourceWidth, sourceHeight, frameAspect);
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 4;
      const maxLongEdge = memory >= 8 ? 3840 : memory >= 4 ? 3200 : 2560;
      const scale = Math.min(1, maxLongEdge / Math.max(crop.width, crop.height));
      const outputWidth = Math.max(1, Math.round(crop.width * scale));
      const outputHeight = Math.max(1, Math.round(crop.height * scale));

      sourceCanvas.width = outputWidth;
      sourceCanvas.height = outputHeight;
      resultCanvas.width = outputWidth;
      resultCanvas.height = outputHeight;

      const sourceContext = sourceCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      });
      const resultContext = resultCanvas.getContext("2d", { alpha: false });
      if (!sourceContext || !resultContext) throw new Error("Canvas is unavailable");

      sourceContext.drawImage(
        source,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        outputWidth,
        outputHeight,
      );
      bitmap?.close();
      bitmap = null;

      const imageData = sourceContext.getImageData(0, 0, outputWidth, outputHeight);
      const softwareCaptureExposure = hardwareMeterActive
        ? meterBias - hardwareAppliedBias
        : softwareMeterExposure + meterBias;
      const developed = await processInWorker(imageData, {
        width: outputWidth,
        height: outputHeight,
        stockId,
        exposure: clampNumber(exposure + softwareCaptureExposure, -3, 3),
        grain: grain / 100,
        halation: halation / 100,
        seed: Date.now() & 0x7fffffff,
      });

      resultContext.putImageData(
        new ImageData(developed, outputWidth, outputHeight),
        0,
        0,
      );
      const blob = await canvasToBlob(resultCanvas);
      resultBlobRef.current = blob;
      const file = new File([blob], "filmsim-35mm.jpg", { type: "image/jpeg" });
      setCanShare(Boolean(navigator.canShare?.({ files: [file] })));
      setMeta({
        source: sourceType,
        sourceWidth,
        sourceHeight,
        outputWidth,
        outputHeight,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      setPhase("result");
    } catch (error) {
      bitmap?.close();
      setMessage(error instanceof Error ? error.message : "The frame could not be developed");
      setPhase("error");
    }
  }

  function retake() {
    setMeta(null);
    setComparing(false);
    setMessage("");
    resultBlobRef.current = null;
    setPhase(streamRef.current ? "live" : "request");
  }

  async function savePhoto() {
    const blob = resultBlobRef.current;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.href = url;
    anchor.download = `filmsim-35mm-${stockId}-${stamp}.jpg`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function sharePhoto() {
    const blob = resultBlobRef.current;
    if (!blob || !navigator.share) return;
    const file = new File([blob], `filmsim-35mm-${stockId}.jpg`, {
      type: "image/jpeg",
    });
    try {
      await navigator.share({ files: [file], title: "FilmSim 35mm" });
    } catch {
      // The native share sheet reports cancellation as an error.
    }
  }

  const selectedStock = STOCKS.find((stock) => stock.id === stockId) ?? STOCKS[0];
  const resultVisible = phase === "result" || phase === "developing";

  return (
    <main className="cameraApp">
      <div className="ambientGlow" aria-hidden="true" />

      <header className="topBar">
        <div className="brand" aria-label="FilmSim 35 millimetres">
          <span>FILM SIM</span>
          <strong>35</strong>
        </div>

        <div className={`phaseBadge phase-${phase}`} aria-live="polite">
          <i />
          {phase === "live" && "CAMERA"}
          {phase === "developing" && "DEVELOPING"}
          {phase === "result" && "READY"}
          {(phase === "request" || phase === "error") && "STANDBY"}
        </div>

        <button
          className="iconButton"
          type="button"
          onClick={() => void switchCamera()}
          disabled={phase === "developing"}
          aria-label="Switch camera"
        >
          ↻
        </button>
      </header>

      <section className="cameraStage" aria-label="35 mm viewfinder">
        <div className="filmGate" ref={frameRef}>
          <video
            ref={videoRef}
            className={`cameraVideo ${facing === "user" ? "mirror" : ""} ${
              phase === "live" ? "visible" : ""
            }`}
            playsInline
            muted
            autoPlay
          />
          <canvas
            ref={sourceCanvasRef}
            className={`captureCanvas sourceCanvas ${resultVisible ? "visible" : ""}`}
            aria-label="Original frame"
          />
          <canvas
            ref={resultCanvasRef}
            className={`captureCanvas resultCanvas ${
              phase === "result" && !comparing ? "visible" : ""
            }`}
            aria-label="Developed frame"
          />

          <div className="viewfinderShade" aria-hidden="true" />
          <div className="gateCorners" aria-hidden="true">
            <i /><i /><i /><i />
          </div>

          {phase === "live" && (
            <>
              <button
                className="meteringSurface"
                type="button"
                aria-label="Select focus and exposure point"
                onPointerDown={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  meterFromViewPoint(
                    (event.clientX - bounds.left) / bounds.width,
                    (event.clientY - bounds.top) / bounds.height,
                    bounds.width,
                    bounds.height,
                  );
                }}
                onDoubleClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  meterFromViewPoint(0.5, 0.5, bounds.width, bounds.height);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  meterFromViewPoint(0.5, 0.5, bounds.width, bounds.height);
                }}
              />

              {!meterPoint && (
                <div className="meterHint" aria-hidden="true">
                  {meteringAvailability === "checking" && "CHECKING CAMERA"}
                  {meteringAvailability === "hardware" && "TAP · FOCUS / METER"}
                  {meteringAvailability === "software" && "TAP · SPOT METER"}
                </div>
              )}

              {meterPoint && (
                <>
                  <div
                    className={`meterReticle meter-${meteringStatus}`}
                    style={{
                      left: `${meterPoint.viewX * 100}%`,
                      top: `${meterPoint.viewY * 100}%`,
                    }}
                    aria-live="polite"
                  >
                    <i /><i /><i /><i />
                    <span>
                      {meteringStatus === "focusing" && "AF · AE…"}
                      {meteringStatus === "hardware" && "AF · AE"}
                      {meteringStatus === "software" &&
                        `AE SIM ${signedStops(softwareMeterExposure + meterBias)}`}
                    </span>
                  </div>

                  <label className="meterBiasControl">
                    <span aria-hidden="true">☀</span>
                    <span className="meterBiasTrack">
                      <input
                        type="range"
                        min={meterBiasRange.min}
                        max={meterBiasRange.max}
                        step={meterBiasRange.step}
                        value={meterBias}
                        onChange={(event) => changeMeterBias(Number(event.target.value))}
                        aria-label="Selected-point exposure compensation"
                      />
                    </span>
                    <output>AE {signedStops(meterBias)}</output>
                  </label>
                </>
              )}
            </>
          )}

          {(phase === "request" || phase === "error") && (
            <div className="permissionCard">
              <div className="apertureMark" aria-hidden="true"><i /></div>
              <p className="eyebrow">LOCAL CAMERA</p>
              <h1>{phase === "error" ? "Camera unavailable" : "Allow camera access"}</h1>
              <p>
                Your photo is developed in the browser and never uploaded.
              </p>
              {message && <small>{message}</small>}
              <button type="button" onClick={() => void startCamera(facing)}>
                Enable camera
              </button>
            </div>
          )}

          {phase === "developing" && (
            <div className="developingCard" aria-live="assertive">
              <div className="developingRing"><i /></div>
              <p>DEVELOPING NEGATIVE</p>
              <span>tone · color · grain · halation</span>
            </div>
          )}

          {phase === "result" && (
            <div className="resultInfo">
              <span>{selectedStock.name}</span>
              {meta && (
                <small>
                  {meta.source === "photo" ? "FULL PHOTO" : "VIDEO FALLBACK"} · {megapixels(meta.outputWidth, meta.outputHeight)} · {(meta.elapsedMs / 1000).toFixed(1)} s
                </small>
              )}
            </div>
          )}
        </div>
      </section>

      {phase === "live" && (
        <section className="liveControls" aria-label="Film settings">
          <label className="stockPicker">
            <span>EMULSION</span>
            <select value={stockId} onChange={(event) => setStockId(event.target.value as StockId)}>
              {STOCKS.map((stock) => (
                <option key={stock.id} value={stock.id}>
                  {stock.name} · {stock.note}
                </option>
              ))}
            </select>
          </label>
          <button className="exposureChip" type="button" onClick={() => setSettingsOpen(true)}>
            FILM EV {signedStops(exposure)}
          </button>
        </section>
      )}

      <footer className={`bottomBar ${phase === "result" ? "resultActions" : ""}`}>
        {phase === "live" && (
          <>
            <button className="textButton" type="button" onClick={() => setSettingsOpen(true)}>
              SETTINGS
            </button>
            <button className="shutter" type="button" onClick={() => void takePicture()} aria-label="Take photo">
              <span />
            </button>
            <div className="frameCounter" aria-label={`Film ISO ${selectedStock.iso}`}>
              <span>ISO</span>
              <strong>{selectedStock.iso}</strong>
            </div>
          </>
        )}

        {phase === "developing" && <p className="processingNote">Keep the camera open</p>}

        {phase === "result" && (
          <>
            <button className="actionButton muted" type="button" onClick={retake}>Retake</button>
            <button
              className="actionButton compareButton"
              type="button"
              onPointerDown={() => setComparing(true)}
              onPointerUp={() => setComparing(false)}
              onPointerCancel={() => setComparing(false)}
              onPointerLeave={() => setComparing(false)}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") setComparing(true);
              }}
              onKeyUp={() => setComparing(false)}
            >
              {comparing ? "Original" : "Compare"}
            </button>
            <button className="actionButton primary" type="button" onClick={() => void savePhoto()}>Save</button>
            {canShare && (
              <button className="actionButton share" type="button" onClick={() => void sharePhoto()}>Share</button>
            )}
          </>
        )}
      </footer>

      {settingsOpen && phase === "live" && (
        <div className="settingsBackdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <section className="settingsSheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <div className="sheetHandle" aria-hidden="true" />
            <header>
              <div>
                <p className="eyebrow">35 MM PROCESS</p>
                <h2 id="settings-title">Development settings</h2>
              </div>
              <button className="closeButton" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button>
            </header>

            <label className="rangeControl">
              <span><b>Film exposure</b><output>{signedStops(exposure)} EV</output></span>
              <input type="range" min="-2" max="2" step="0.1" value={exposure} onChange={(event) => setExposure(Number(event.target.value))} />
              <small>Adjusts exposure before the film response curve is applied.</small>
            </label>

            <label className="rangeControl">
              <span><b>Grain</b><output>{grain}%</output></span>
              <input type="range" min="0" max="160" step="5" value={grain} onChange={(event) => setGrain(Number(event.target.value))} />
              <small>Grain size is tied to a virtual 36 × 24 mm frame.</small>
            </label>

            <label className="rangeControl">
              <span><b>Halation</b><output>{halation}%</output></span>
              <input type="range" min="0" max="160" step="5" value={halation} onChange={(event) => setHalation(Number(event.target.value))} />
              <small>Red-orange light spread around strong highlights.</small>
            </label>

            <button className="sheetDone" type="button" onClick={() => setSettingsOpen(false)}>Done</button>
          </section>
        </div>
      )}
    </main>
  );
}
