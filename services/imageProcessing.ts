import { Rect } from '../types';

export const cropImage = async (
  sourceImage: HTMLImageElement,
  crop: Rect, // These should be in NATURAL (original image) pixels
  options: {
    enhance: boolean;
    threshold: number; // 0-255
    invert: boolean;
    removeBorders: boolean;
  },
  maskUrl?: string // New: Accept an eraser mask
): Promise<string> => {
  const canvas = document.createElement('canvas');
  
  // Safety check for negative width/height
  const pixelX = Math.max(0, crop.x);
  const pixelY = Math.max(0, crop.y);
  const pixelWidth = Math.min(sourceImage.naturalWidth - pixelX, Math.abs(crop.width));
  const pixelHeight = Math.min(sourceImage.naturalHeight - pixelY, Math.abs(crop.height));

  if (pixelWidth <= 0 || pixelHeight <= 0) return '';

  canvas.width = pixelWidth;
  canvas.height = pixelHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // 1. Draw the cropped area from original
  ctx.drawImage(
    sourceImage,
    pixelX,
    pixelY,
    pixelWidth,
    pixelHeight,
    0,
    0,
    pixelWidth,
    pixelHeight
  );

  // 2. Remove Borders (Improved Algorithm)
  if (options.removeBorders) {
    removeLinearStructures(ctx, pixelWidth, pixelHeight, options.threshold, options.invert);
  }

  // 3. Apply Threshold/Binarization
  if (options.enhance) {
    applyBinarization(ctx, pixelWidth, pixelHeight, options.threshold, options.invert);
  }

  // 4. Apply Manual Eraser Mask (if exists)
  if (maskUrl) {
    await new Promise<void>((resolve) => {
      const maskImg = new Image();
      maskImg.onload = () => {
        ctx.globalCompositeOperation = 'destination-out'; // Cut out the masked areas
        ctx.drawImage(maskImg, 0, 0, pixelWidth, pixelHeight);
        ctx.globalCompositeOperation = 'source-over'; // Reset
        resolve();
      };
      maskImg.onerror = () => resolve(); // Fail safe
      maskImg.src = maskUrl;
    });
  }

  return canvas.toDataURL('image/png');
};

// Helper to check if a pixel is considered "dark" (ink/line) vs "light" (background)
const isDark = (r: number, g: number, b: number, threshold: number, invert: boolean) => {
  let val = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (invert) val = 255 - val;
  return val <= threshold; // Dark is below threshold
};

// Improved Border Removal: Density based instead of strict run-length
const removeLinearStructures = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  threshold: number,
  invert: boolean
) => {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const pixelsToRemove = new Uint8Array(width * height);

  // Configuration
  const minDensity = 0.65; // If > 65% of a row/col is dark, consider it a border line
  const edgePadding = 0.15; // Only look for borders in the outer 15% of the image (optional, but safer)
  
  // Note: We scan the WHOLE image for lines, because sometimes crops include internal divider lines.
  // But strictly removing lines in the middle might erase signature strokes (like a long 't' crossing).
  // So we will be aggressive on the edges, and conservative in the middle?
  // User request: "Remove Borders". Usually implies the box around the signature.
  // We will scan the whole image but require high density.

  // 1. Horizontal Scan (Rows)
  for (let y = 0; y < height; y++) {
    let darkCount = 0;
    
    // Count dark pixels in this row
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isDark(data[i], data[i+1], data[i+2], threshold, invert)) {
        darkCount++;
      }
    }

    // If row is mostly dark, mark for removal
    if (darkCount / width > minDensity) {
      for (let x = 0; x < width; x++) {
        pixelsToRemove[y * width + x] = 1;
      }
    }
  }

  // 2. Vertical Scan (Cols)
  for (let x = 0; x < width; x++) {
    let darkCount = 0;
    
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (isDark(data[i], data[i+1], data[i+2], threshold, invert)) {
        darkCount++;
      }
    }

    if (darkCount / height > minDensity) {
      for (let y = 0; y < height; y++) {
        pixelsToRemove[y * width + x] = 1;
      }
    }
  }

  // Apply removal
  // We also expand the removal slightly (1px) to clean artifacts
  for (let i = 0; i < pixelsToRemove.length; i++) {
    if (pixelsToRemove[i] === 1) {
      const offset = i * 4;
      data[offset] = 255;
      data[offset+1] = 255;
      data[offset+2] = 255;
      data[offset+3] = 0; // Transparent
    }
  }

  ctx.putImageData(imageData, 0, 0);
};

const applyBinarization = (
  ctx: CanvasRenderingContext2D, 
  width: number, 
  height: number, 
  threshold: number,
  invert: boolean
) => {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    // Skip already transparent pixels (from border removal)
    if (a === 0) continue;

    // Grayscale using luminance formula
    let val = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    if (invert) {
      val = 255 - val;
    }
    
    if (val > threshold) {
      data[i] = 255;     
      data[i + 1] = 255; 
      data[i + 2] = 255; 
      data[i + 3] = 0;   // Transparent
    } else {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255; // Black ink
    }
  }

  ctx.putImageData(imageData, 0, 0);
};