// Turns picked files into Parts.
//
// The picker itself is a plain <input type="file" accept="image/png"
// multiple>, which Capacitor's Android bridge surfaces as the native file
// chooser (and which supports selecting many files at once). Everything
// here is format validation, decoding, and choosing a sensible starting
// position/scale.

import { Part, partsStore } from './parts.js';

// Fraction of the canvas's shorter side a freshly imported part should
// roughly occupy, so a 32x32 sprite isn't a speck on a phone screen.
const TARGET_SIZE_FRACTION = 0.35;

// Each new part is nudged down-right from the last so a batch import
// doesn't leave eight parts perfectly stacked and impossible to separate.
const CASCADE_STEP = 14;
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

// Pixel art wants whole-number magnification, so upscaling snaps to an
// integer factor. Shrinking an oversized source has to stay fractional.
function initialScale(image, viewSize) {
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (longestSide === 0) return 1;

  const target = Math.min(viewSize.width, viewSize.height) * TARGET_SIZE_FRACTION;
  const fitted = target / longestSide;
  return fitted >= 1 ? Math.floor(fitted) : fitted;
}

function initialPosition(viewSize, cascadeIndex) {
  const offset = (cascadeIndex % CASCADE_WRAP) * CASCADE_STEP;
  return {
    x: viewSize.width / 2 + offset,
    y: viewSize.height / 2 + offset,
  };
}

// Imports every PNG in the list, adding one Part per file. Returns a
// summary so the caller can tell the user what was skipped: non-PNG files
// are rejected outright (JPG has no alpha channel, so it can't carry
// pixel-art cutouts), and anything that fails to decode is reported too.
export async function importFiles(fileList, viewSize) {
  const files = Array.from(fileList);
  const rejected = files.filter((file) => !isPng(file)).map((file) => file.name);
  const failed = [];
  let imported = 0;

  for (const file of files.filter(isPng)) {
    try {
      const { image, objectUrl } = await loadImage(file);
      const position = initialPosition(viewSize, partsStore.parts.length);

      const part = partsStore.add(
        new Part({
          name: displayName(file.name),
          image,
          objectUrl,
          x: position.x,
          y: position.y,
          scale: initialScale(image, viewSize),
        })
      );
      partsStore.select(part.id);
      imported += 1;
    } catch (error) {
      console.warn(error);
      failed.push(file.name);
    }
  }

  return { imported, rejected, failed };
}
