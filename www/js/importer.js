// Turns picked files into Parts.
//
// The picker itself is a plain <input type="file" accept="image/png"
// multiple>, which Capacitor's Android bridge surfaces as the native file
// chooser (and which supports selecting many files at once). Everything
// here is validation, decoding, and placing the image on the pixel grid.

import { Part, partsStore } from './parts.js';
import { sceneStore } from './scene.js';

export const MIN_IMAGE_SIZE = 8;

// Each new part is nudged down-right from the last by whole grid cells,
// so a batch import doesn't leave eight parts perfectly stacked.
const CASCADE_STEP = 8;
const CASCADE_WRAP = 6;

function isPng(file) {
  return file.type === 'image/png' || /\.png$/i.test(file.name);
}

function displayName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Could not decode ${file.name}`));
    };
    image.src = objectUrl;
  });
}

// The rasterizer samples texels straight from memory, so decode the PNG
// into raw RGBA bytes once here rather than on every frame.
function readPixels(image) {
  const scratch = document.createElement('canvas');
  scratch.width = image.naturalWidth;
  scratch.height = image.naturalHeight;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, scratch.width, scratch.height).data;
}

function sizeProblem(image) {
  const { naturalWidth: w, naturalHeight: h } = image;
  if (w < MIN_IMAGE_SIZE || h < MIN_IMAGE_SIZE) {
    return `is ${w}×${h}, smaller than the ${MIN_IMAGE_SIZE}×${MIN_IMAGE_SIZE} minimum`;
  }
  if (w > sceneStore.width || h > sceneStore.height) {
    return `is ${w}×${h}, larger than the ${sceneStore.width}×${sceneStore.height} canvas`;
  }
  return null;
}

// Whole-cell placement: centred on the grid (rounded down to an integer),
// then cascaded by whole cells. The scale is always 1 -- one image pixel
// per grid cell -- because any other default would need interpolation.
function initialPosition(image, cascadeIndex) {
  const offset = (cascadeIndex % CASCADE_WRAP) * CASCADE_STEP;
  return {
    x: Math.floor((sceneStore.width - image.naturalWidth) / 2) + offset,
    y: Math.floor((sceneStore.height - image.naturalHeight) / 2) + offset,
  };
}

// ---------------------------------------------------------------------------
// Position-preserving import
//
// A layer exported from another app at the FULL project size carries its
// position in its transparent padding: the artwork sits where it sat in the
// original composition, and everything else is transparent. When such a file
// is imported into a canvas of exactly the same size, that padding is the
// placement -- so several layers cut from one artwork reassemble themselves.
//
// It only applies on an EXACT match with whatever canvas size is configured
// at that moment. Any other size cannot carry position information: the same
// padding means a different place on a differently sized grid, so guessing
// would silently misplace the layer.

// The tight box around every pixel with a non-zero alpha, or null when the
// image is fully transparent.
function contentBounds(pixels, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (pixels[rowStart + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Copies the bounding box out of the decoded image, row by row.
function cropPixels(pixels, width, bounds) {
  const out = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  const rowBytes = bounds.width * 4;
  for (let row = 0; row < bounds.height; row++) {
    const from = ((bounds.y + row) * width + bounds.x) * 4;
    out.set(pixels.subarray(from, from + rowBytes), row * rowBytes);
  }
  return out;
}

// Imports every usable PNG, one Part per file. Returns what was skipped so
// the caller can tell the user: non-PNGs (no alpha channel, so no pixel-art
// cutouts), files that fail to decode, images outside the size limits, and
// canvas-sized files that turned out to be entirely transparent. Also
// returns which files could not be auto-positioned and why, so the user is
// told rather than left wondering.
export async function importFiles(fileList) {
  const files = Array.from(fileList);
  const rejected = files.filter((file) => !isPng(file)).map((file) => file.name);
  const failed = [];
  const wrongSize = [];
  const blank = [];
  const manualPlacement = [];
  let imported = 0;
  let autoPlaced = 0;
  // Only manually placed parts consume a cascade slot, so auto-positioned
  // layers never push the next manual one off-centre.
  let cascadeIndex = partsStore.parts.filter((part) => part.placement === 'manual').length;

  for (const file of files.filter(isPng)) {
    try {
      const { image, objectUrl } = await loadImage(file);

      const problem = sizeProblem(image);
      if (problem) {
        URL.revokeObjectURL(objectUrl);
        wrongSize.push(`${file.name} ${problem}`);
        continue;
      }

      // Read the canvas size as it is right now, per file.
      const canvasWidth = sceneStore.width;
      const canvasHeight = sceneStore.height;
      const importedWidth = image.naturalWidth;
      const importedHeight = image.naturalHeight;
      const matchesCanvas = importedWidth === canvasWidth && importedHeight === canvasHeight;

      const pixels = readPixels(image);
      let options;

      if (matchesCanvas) {
        const bounds = contentBounds(pixels, importedWidth, importedHeight);
        if (!bounds) {
          URL.revokeObjectURL(objectUrl);
          blank.push(`${file.name} is fully transparent`);
          continue;
        }
        // Trimmed to its artwork and placed at the offset that padding
        // implied. The full-size decode is released here: nothing reads it
        // once the pixels are cropped, and at canvas sizes it is large.
        URL.revokeObjectURL(objectUrl);
        options = {
          image: null,
          pixels: cropPixels(pixels, importedWidth, bounds),
          width: bounds.width,
          height: bounds.height,
          objectUrl: null,
          x: bounds.x,
          y: bounds.y,
          placement: 'auto',
        };
        autoPlaced += 1;
      } else {
        const position = initialPosition(image, cascadeIndex);
        cascadeIndex += 1;
        manualPlacement.push(
          `${file.name} is ${importedWidth}×${importedHeight}, canvas is ${canvasWidth}×${canvasHeight}`
        );
        options = {
          image,
          pixels,
          width: importedWidth,
          height: importedHeight,
          objectUrl,
          x: position.x,
          y: position.y,
          placement: 'manual',
        };
      }

      const part = partsStore.add(new Part({ name: displayName(file.name), scale: 1, ...options }));
      partsStore.select(part.id);
      imported += 1;
    } catch (error) {
      console.warn(error);
      failed.push(file.name);
    }
  }

  return { imported, autoPlaced, rejected, failed, wrongSize, blank, manualPlacement };
}
