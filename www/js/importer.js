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

// Imports every usable PNG, one Part per file. Returns what was skipped so
// the caller can tell the user: non-PNGs (no alpha channel, so no pixel-art
// cutouts), files that fail to decode, and images outside the size limits.
export async function importFiles(fileList) {
  const files = Array.from(fileList);
  const rejected = files.filter((file) => !isPng(file)).map((file) => file.name);
  const failed = [];
  const wrongSize = [];
  let imported = 0;

  for (const file of files.filter(isPng)) {
    try {
      const { image, objectUrl } = await loadImage(file);

      const problem = sizeProblem(image);
      if (problem) {
        URL.revokeObjectURL(objectUrl);
        wrongSize.push(`${file.name} ${problem}`);
        continue;
      }

      const position = initialPosition(image, partsStore.parts.length);
      const part = partsStore.add(
        new Part({
          name: displayName(file.name),
          image,
          pixels: readPixels(image),
          objectUrl,
          x: position.x,
          y: position.y,
          scale: 1,
        })
      );
      partsStore.select(part.id);
      imported += 1;
    } catch (error) {
      console.warn(error);
      failed.push(file.name);
    }
  }

  return { imported, rejected, failed, wrongSize };
}
