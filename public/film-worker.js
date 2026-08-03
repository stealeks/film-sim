"use strict";

const STOCKS = {
  "gold-200": {
    mono: false,
    iso: 200,
    rgb: [1.072, 1.006, 0.928],
    matrix: [
      1.086, -0.046, -0.04,
      -0.018, 1.042, -0.024,
      0.003, 0.047, 0.95,
    ],
    tone: {
      speed: 1.12, toe: 0.78, white: 1.58, contrast: 1.1,
      pivot: 0.448, gamma: 0.995, shadow: -0.005, highlight: -0.003,
    },
    saturation: 1.04,
    shadowDesat: 0.07,
    highlightDesat: 0.14,
    saturationCompression: 0.18,
    shadowTint: [0.006, 0.001, 0.016],
    highlightTint: [0.063, 0.031, -0.031],
    blackLift: 0.008,
    grainMicrons: 10.5,
    grainDensity: 0.034,
    chromaGrain: 0.0055,
    halationThreshold: 0.68,
    halationMicrons: 98,
    halationStrength: 0.044,
    halationColor: [1.23, 0.39, 0.075],
    bloom: 0.007,
  },
  "tx400": {
    mono: true,
    iso: 400,
    filter: [0.29, 0.61, 0.1],
    rgb: [1.0, 1.0, 0.985],
    matrix: [
      1.018, -0.01, -0.008,
      -0.008, 1.016, -0.008,
      0.0, 0.01, 0.99,
    ],
    tone: {
      speed: 1.18, toe: 0.72, white: 1.38, contrast: 1.24,
      pivot: 0.43, gamma: 0.985, shadow: -0.02, highlight: 0.004,
    },
    saturation: 0,
    shadowDesat: 0,
    highlightDesat: 0,
    saturationCompression: 0,
    shadowTint: [0, 0, 0],
    highlightTint: [0, 0, 0],
    blackLift: 0.004,
    grainMicrons: 18.5,
    grainDensity: 0.07,
    chromaGrain: 0,
    halationThreshold: 0.74,
    halationMicrons: 60,
    halationStrength: 0.009,
    halationColor: [1, 1, 1],
    bloom: 0.003,
  },
};

const SRGB_TO_LINEAR = (() => {
  const values = new Float32Array(256);
  for (let index = 0; index < values.length; index += 1) {
    const value = index / 255;
    values[index] = value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }
  return values;
})();

const OUTPUT_LUT_SIZE = 16384;
const LINEAR_TO_SRGB = (() => {
  const values = new Uint8ClampedArray(OUTPUT_LUT_SIZE + 1);
  for (let index = 0; index <= OUTPUT_LUT_SIZE; index += 1) {
    const value = index / OUTPUT_LUT_SIZE;
    const encoded = value <= 0.0031308
      ? value * 12.92
      : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
    values[index] = Math.round(encoded * 255);
  }
  return values;
})();

function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function luma(red, green, blue) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function linearByte(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 255;
  return LINEAR_TO_SRGB[Math.round(value * OUTPUT_LUT_SIZE)];
}

function hashNoise(x, y, seed) {
  let value = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1597334677)) | 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function hable(value) {
  const A = 0.22;
  const B = 0.3;
  const C = 0.1;
  const D = 0.2;
  const E = 0.01;
  const F = 0.3;
  return ((value * (A * value + C * B) + D * E) /
    (value * (A * value + B) + D * F)) - E / F;
}

function characteristicCurve(value, tone, channelBias) {
  let exposure = Math.max(0, value * tone.speed * channelBias);
  exposure = Math.pow(exposure, tone.toe);
  const referenceWhite = hable(tone.white);
  let output = referenceWhite > 0 ? hable(exposure) / referenceWhite : hable(exposure);
  output = tone.pivot + (output - tone.pivot) * tone.contrast;
  const toeMask = 1 - smoothstep(0.045, 0.37, output);
  const shoulderMask = smoothstep(0.57, 0.98, output);
  output += tone.shadow * toeMask + tone.highlight * shoulderMask;
  output = clamp01(output);
  return tone.gamma === 1 ? output : Math.pow(output, tone.gamma);
}

function compressSaturation(red, green, blue, amount) {
  const luminance = luma(red, green, blue);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const saturation = maximum > 0 ? (maximum - minimum) / maximum : 0;
  const compression = amount * smoothstep(0.34, 0.92, saturation) * smoothstep(0.08, 0.68, maximum - minimum);
  const density = 1 - compression * 0.055;
  return [
    (luminance + (red - luminance) * (1 - compression)) * density,
    (luminance + (green - luminance) * (1 - compression)) * density,
    (luminance + (blue - luminance) * (1 - compression)) * density,
  ];
}

function blurMap(source, width, height, passes) {
  let current = source;
  let temporary = new Float32Array(source.length);
  const weights = [1, 4, 6, 4, 1];

  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let offset = -2; offset <= 2; offset += 1) {
          const sampleX = clamp(x + offset, 0, width - 1);
          sum += current[row + sampleX] * weights[offset + 2];
        }
        temporary[row + x] = sum / 16;
      }
    }

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let offset = -2; offset <= 2; offset += 1) {
          const sampleY = clamp(y + offset, 0, height - 1);
          sum += temporary[sampleY * width + x] * weights[offset + 2];
        }
        current[row + x] = sum / 16;
      }
    }
  }

  return current;
}

function physicalScale(width, height) {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  return Math.min(longEdge / 36, shortEdge / 24);
}

function buildHalationMap(source, width, height, stock, exposure, amount) {
  if (amount <= 0 || stock.halationStrength <= 0) return null;

  const pixelsPerMillimetre = physicalScale(width, height);
  const radiusPixels = stock.halationMicrons * 0.001 * pixelsPerMillimetre;
  const scale = clamp(Math.round(radiusPixels / 2.5), 2, 8);
  const mapWidth = Math.max(1, Math.ceil(width / scale));
  const mapHeight = Math.max(1, Math.ceil(height / scale));
  const direct = new Float32Array(mapWidth * mapHeight);

  for (let mapY = 0; mapY < mapHeight; mapY += 1) {
    const y = Math.min(height - 1, mapY * scale);
    for (let mapX = 0; mapX < mapWidth; mapX += 1) {
      const x = Math.min(width - 1, mapX * scale);
      const index = (y * width + x) * 4;
      const red = SRGB_TO_LINEAR[source[index]];
      const green = SRGB_TO_LINEAR[source[index + 1]];
      const blue = SRGB_TO_LINEAR[source[index + 2]];
      const luminance = luma(red, green, blue) * exposure;
      const warmBias = 0.88 + 0.12 * smoothstep(-0.03, 0.18, red - Math.max(green, blue));
      direct[mapY * mapWidth + mapX] = Math.pow(
        smoothstep(stock.halationThreshold, 1.12, luminance) * warmBias,
        1.22,
      );
    }
  }

  const core = new Float32Array(direct);
  const passes = clamp(Math.round(radiusPixels / Math.max(1, scale * 1.35)), 2, 9);
  const blurred = blurMap(direct, mapWidth, mapHeight, passes);
  for (let index = 0; index < blurred.length; index += 1) {
    blurred[index] = Math.max(0, blurred[index] - core[index] * 0.14);
  }

  return { values: blurred, width: mapWidth, height: mapHeight, scale };
}

function sampleHalation(halation, x, y) {
  if (!halation) return 0;
  const fx = clamp(x / halation.scale, 0, halation.width - 1);
  const fy = clamp(y / halation.scale, 0, halation.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(halation.width - 1, x0 + 1);
  const y1 = Math.min(halation.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = halation.values[y0 * halation.width + x0] * (1 - tx) + halation.values[y0 * halation.width + x1] * tx;
  const bottom = halation.values[y1 * halation.width + x0] * (1 - tx) + halation.values[y1 * halation.width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function develop(source, width, height, stock, controls, seed) {
  const output = new Uint8ClampedArray(source.length);
  const exposure = Math.pow(2, controls.exposure);
  const halationMap = buildHalationMap(source, width, height, stock, exposure, controls.halation);
  const pixelsPerMillimetre = physicalScale(width, height);
  const grainCell = Math.max(0.72, stock.grainMicrons * 0.001 * pixelsPerMillimetre);
  const isoGrain = Math.pow(stock.iso / 400, 0.19);
  const matrix = stock.matrix;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      let red = SRGB_TO_LINEAR[source[index]] * exposure * stock.rgb[0];
      let green = SRGB_TO_LINEAR[source[index + 1]] * exposure * stock.rgb[1];
      let blue = SRGB_TO_LINEAR[source[index + 2]] * exposure * stock.rgb[2];

      const matrixRed = Math.max(0, red * matrix[0] + green * matrix[1] + blue * matrix[2]);
      const matrixGreen = Math.max(0, red * matrix[3] + green * matrix[4] + blue * matrix[5]);
      const matrixBlue = Math.max(0, red * matrix[6] + green * matrix[7] + blue * matrix[8]);
      red = matrixRed;
      green = matrixGreen;
      blue = matrixBlue;

      let luminance = luma(red, green, blue);
      const shadowBeforeCurve = 1 - smoothstep(0.035, 0.32, luminance);
      const highlightBeforeCurve = smoothstep(0.54, 1.08, luminance);
      red += stock.shadowTint[0] * shadowBeforeCurve + stock.highlightTint[0] * highlightBeforeCurve;
      green += stock.shadowTint[1] * shadowBeforeCurve + stock.highlightTint[1] * highlightBeforeCurve;
      blue += stock.shadowTint[2] * shadowBeforeCurve + stock.highlightTint[2] * highlightBeforeCurve;

      const halo = sampleHalation(halationMap, x, y) * controls.halation;
      red += halo * stock.halationStrength * stock.halationColor[0];
      green += halo * stock.halationStrength * stock.halationColor[1];
      blue += halo * stock.halationStrength * stock.halationColor[2];

      red = characteristicCurve(red, stock.tone, 1.01);
      green = characteristicCurve(green, stock.tone, 1.0);
      blue = characteristicCurve(blue, stock.tone, 0.99);

      if (stock.mono) {
        const grey = clamp01(stock.filter[0] * red + stock.filter[1] * green + stock.filter[2] * blue);
        red = grey;
        green = grey;
        blue = grey;
      } else {
        luminance = luma(red, green, blue);
        const shadow = 1 - smoothstep(0.045, 0.31, luminance);
        const highlight = smoothstep(0.59, 0.98, luminance);
        const compressed = compressSaturation(
          red,
          green,
          blue,
          stock.saturationCompression * (0.72 + 0.28 * highlight),
        );
        red = compressed[0];
        green = compressed[1];
        blue = compressed[2];
        luminance = luma(red, green, blue);
        const saturation = stock.saturation *
          (1 - stock.shadowDesat * shadow - stock.highlightDesat * highlight);
        red = luminance + (red - luminance) * saturation;
        green = luminance + (green - luminance) * saturation;
        blue = luminance + (blue - luminance) * saturation;
      }

      red = red * (1 - stock.blackLift) + stock.blackLift;
      green = green * (1 - stock.blackLift) + stock.blackLift;
      blue = blue * (1 - stock.blackLift) + stock.blackLift;

      luminance = clamp01(luma(red, green, blue));
      const grainX = Math.floor((x + grainCell * 0.37) / grainCell);
      const grainY = Math.floor((y + grainCell * 0.61) / grainCell);
      const clump = hashNoise(grainX, grainY, seed + 17) - 0.5;
      const fine = hashNoise(x, y, seed + 113) - 0.5;
      const grainNoise = clump * 0.86 + fine * 0.44;
      const grainMask = 0.58 + 0.72 * (1 - luminance) + 0.12 * smoothstep(0.76, 1, luminance);
      const densityDelta = grainNoise * stock.grainDensity * controls.grain * grainMask * isoGrain;
      const densityFactor = Math.exp(-densityDelta * 2.302585093);
      red *= densityFactor;
      green *= densityFactor;
      blue *= densityFactor;

      if (!stock.mono && controls.grain > 0) {
        const chromaA = (hashNoise(grainX + 71, grainY - 37, seed + 271) - 0.5) * stock.chromaGrain * controls.grain;
        const chromaB = (hashNoise(grainX - 29, grainY + 83, seed + 349) - 0.5) * stock.chromaGrain * controls.grain;
        red *= Math.exp(-chromaA * 1.9);
        green *= Math.exp((chromaA * 0.72 - chromaB * 0.28) * 1.2);
        blue *= Math.exp(-chromaB * 1.75);
      }

      if (halo > 0) {
        const bloom = halo * stock.bloom * controls.halation;
        if (stock.mono) {
          red += bloom;
          green += bloom;
          blue += bloom;
        } else {
          red += bloom;
          green += bloom * 0.82;
          blue += bloom * 0.62;
        }
      }

      output[index] = linearByte(red);
      output[index + 1] = linearByte(green);
      output[index + 2] = linearByte(blue);
      output[index + 3] = 255;
    }
  }

  return output;
}

self.onmessage = (event) => {
  const payload = event.data;
  if (!payload || payload.type !== "develop") return;

  try {
    const width = Number(payload.width);
    const height = Number(payload.height);
    const stock = STOCKS[payload.stockId] || STOCKS["gold-200"];
    const source = new Uint8ClampedArray(payload.buffer);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error("Некорректный размер кадра");
    }
    if (source.length !== width * height * 4) {
      throw new Error("Кадр повреждён");
    }

    const controls = {
      exposure: clamp(Number(payload.exposure) || 0, -3, 3),
      grain: clamp(Number(payload.grain) || 0, 0, 2),
      halation: clamp(Number(payload.halation) || 0, 0, 2),
    };
    const output = develop(source, width, height, stock, controls, Number(payload.seed) || 1);
    self.postMessage(
      { type: "developed", id: payload.id, buffer: output.buffer },
      [output.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      id: payload.id,
      message: error instanceof Error ? error.message : "Неизвестная ошибка проявки",
    });
  }
};
