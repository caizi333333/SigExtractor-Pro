export interface ExtractionSettings {
  enhance: boolean;
  threshold: number; // 0-255
  invert: boolean;
  removeBorders: boolean;
}

export interface Extraction {
  id: string;
  sourceImageIndex: number;
  
  // The coordinate on the original (natural) image
  naturalCrop: Rect; 

  imageUrl: string;
  
  // Stores the user's manual eraser strokes as a separate image layer
  editMaskUrl?: string; 

  name: string;
  timestamp: number;
  
  // Store settings so we can re-process
  settings: ExtractionSettings;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageFile {
  id: string;
  url: string;
  file: File;
}