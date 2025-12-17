import { Rect } from '../types';

/**
 * Detects potential signature regions in an image.
 * Uses a density-grid based approach with morphological dilation to group text strokes.
 */
export const detectSignatures = (
  imageElement: HTMLImageElement, 
  options: {
    sensitivity?: number; // 0-1, higher means more sensitive to faint lines
    minWidth?: number;    // % of image width
    maxWidth?: number;    // % of image width
    minHeight?: number;   // % of image height
  } = {}
): Promise<Rect[]> => {
  return new Promise((resolve) => {
    // 1. Setup processing canvas (downscale for performance)
    const canvas = document.createElement('canvas');
    const processWidth = 800; // Fixed width for consistent processing
    const scale = imageElement.naturalWidth / processWidth;
    const processHeight = Math.round(imageElement.naturalHeight / scale);

    canvas.width = processWidth;
    canvas.height = processHeight;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      resolve([]);
      return;
    }

    // Draw image to canvas
    ctx.drawImage(imageElement, 0, 0, processWidth, processHeight);

    // 2. Get pixel data
    const imageData = ctx.getImageData(0, 0, processWidth, processHeight);
    const data = imageData.data;

    // 3. Grid-based Density Analysis
    // We divide the image into small cells. If a cell has enough 'ink', it's marked active.
    const cellSize = 10; // 10x10 pixels
    const gridW = Math.ceil(processWidth / cellSize);
    const gridH = Math.ceil(processHeight / cellSize);
    const grid = new Uint8Array(gridW * gridH); // 0 = empty, 1 = ink

    const threshold = 180; // Luminance threshold (0-255), pixels darker than this are ink

    for (let y = 0; y < processHeight; y++) {
      for (let x = 0; x < processWidth; x++) {
        const i = (y * processWidth + x) * 4;
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        
        // Simple grayscale luminance
        const val = 0.299 * r + 0.587 * g + 0.114 * b;
        
        if (val < threshold) {
          // It's ink
          const gx = Math.floor(x / cellSize);
          const gy = Math.floor(y / cellSize);
          grid[gy * gridW + gx] = 1;
        }
      }
    }

    // 4. Morphological Dilation (Smearing)
    // Connect adjacent grid cells to form blobs. 
    // Signatures often have gaps between names (e.g. "John [gap] Doe"). We want one box.
    // We expand horizontal connection more aggressively than vertical.
    const smearedGrid = new Uint8Array(gridW * gridH);
    const dilateX = 2; // Expand 2 cells left/right
    const dilateY = 1; // Expand 1 cell up/down

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        if (grid[gy * gridW + gx] === 1) {
          // Spread this active cell to neighbors
          for (let dy = -dilateY; dy <= dilateY; dy++) {
            for (let dx = -dilateX; dx <= dilateX; dx++) {
              const ny = gy + dy;
              const nx = gx + dx;
              if (ny >= 0 && ny < gridH && nx >= 0 && nx < gridW) {
                smearedGrid[ny * gridW + nx] = 1;
              }
            }
          }
        }
      }
    }

    // 5. Connected Component Labeling (Find Blobs)
    const labels = new Int32Array(gridW * gridH).fill(0);
    let currentLabel = 1;
    const blobBounds: Record<number, { minX: number, maxX: number, minY: number, maxY: number, count: number }> = {};

    // Simple recursive flood fill (stack based to avoid recursion limit)
    const getIndex = (x: number, y: number) => y * gridW + x;

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const idx = getIndex(x, y);
        if (smearedGrid[idx] === 1 && labels[idx] === 0) {
          // Found a new blob
          const label = currentLabel++;
          labels[idx] = label;
          
          let minX = x, maxX = x, minY = y, maxY = y, count = 1;
          const stack = [[x, y]];

          while (stack.length > 0) {
            const [cx, cy] = stack.pop()!;
            
            // Update bounds
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;

            // Check neighbors
            const neighbors = [
              [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]
            ];

            for (const [nx, ny] of neighbors) {
              if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
                const nIdx = getIndex(nx, ny);
                if (smearedGrid[nIdx] === 1 && labels[nIdx] === 0) {
                  labels[nIdx] = label;
                  count++;
                  stack.push([nx, ny]);
                }
              }
            }
          }

          blobBounds[label] = { minX, maxX, minY, maxY, count };
        }
      }
    }

    // 6. Convert blobs to Rects and Filter
    const results: Rect[] = [];
    const minW = (options.minWidth || 0.05) * gridW; // Min width 5% of page
    const maxW = (options.maxWidth || 0.90) * gridW; // Max width 90% of page
    const minH = (options.minHeight || 0.02) * gridH; // Min height 2% of page

    Object.values(blobBounds).forEach(blob => {
      const width = blob.maxX - blob.minX + 1;
      const height = blob.maxY - blob.minY + 1;
      
      // Filter logic:
      // 1. Must be large enough (not noise)
      // 2. Must not be the whole page (border)
      // 3. Aspect ratio: Signatures are usually wider than tall (ratio > 1 or close to it)
      
      const isNoise = width < minW || height < minH;
      const isWholePage = width > maxW && height > (gridH * 0.9);
      const isVerticalLine = height > width * 4; // Ignore vertical dividers

      if (!isNoise && !isWholePage && !isVerticalLine) {
        // Convert grid coordinates back to natural image coordinates
        // We add a little padding (1 cell) to ensure we don't clip ascenders/descenders
        const padding = 1;
        const rect: Rect = {
          x: Math.max(0, (blob.minX - padding) * cellSize * scale),
          y: Math.max(0, (blob.minY - padding) * cellSize * scale),
          width: Math.min(imageElement.naturalWidth, (width + padding * 2) * cellSize * scale),
          height: Math.min(imageElement.naturalHeight, (height + padding * 2) * cellSize * scale)
        };
        
        // Ensure bounds are within image
        if (rect.x + rect.width > imageElement.naturalWidth) rect.width = imageElement.naturalWidth - rect.x;
        if (rect.y + rect.height > imageElement.naturalHeight) rect.height = imageElement.naturalHeight - rect.y;

        results.push(rect);
      }
    });

    resolve(results);
  });
};