import * as pdfjsLib from 'pdfjs-dist';
import { ImageFile } from '../types';

// Initialize the PDF.js worker.
// Using the same version as the main library to avoid conflicts.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';

/**
 * Converts a PDF file into a list of ImageFile objects (one per page).
 */
export const convertPdfToImages = async (file: File): Promise<ImageFile[]> => {
  try {
    const arrayBuffer = await file.arrayBuffer();
    
    // Load the PDF document
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const images: ImageFile[] = [];

    // Iterate through all pages
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      
      // Render at a higher scale (3.0) to ensure signatures are sharp when cropped/zoomed
      // Previous 2.0 might be blurry on high-res screens or when zooming in
      const viewport = page.getViewport({ scale: 3.0 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      
      if (!context) continue;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({
        canvasContext: context,
        viewport: viewport
      }).promise;

      // Convert the rendered page to a Blob/File
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      
      if (blob) {
        const pageFilename = `${file.name.replace('.pdf', '')}_page_${i}.jpg`;
        const pageFile = new File([blob], pageFilename, { type: 'image/jpeg' });
        
        images.push({
          id: Math.random().toString(36).substring(7),
          url: URL.createObjectURL(pageFile),
          file: pageFile
        });
      }
    }

    return images;
  } catch (error) {
    console.error("Error converting PDF:", error);
    alert("Failed to process PDF. Please check if the file is valid.");
    return [];
  }
};