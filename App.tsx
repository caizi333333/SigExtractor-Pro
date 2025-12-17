import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, Scissors, Download, Trash2, ZoomIn, ZoomOut, Layers, Wand2, Image as ImageIcon, Loader2, Sliders, RefreshCw, Eraser, X, Check, Undo, ScanLine, BoxSelect, Sparkles, Bot, FileArchive, Maximize, Move } from 'lucide-react';
import { ImageFile, Extraction, Rect } from './types';
import { cropImage } from './services/imageProcessing';
import { convertPdfToImages } from './services/pdfService';
import { detectSignatures } from './services/autoDetection';
import { detectSignaturesWithGemini } from './services/geminiService';
// @ts-ignore
import JSZip from 'jszip';

// --- Sub-component: Eraser Modal ---
interface EraserModalProps {
  isOpen: boolean;
  imageUrl: string;
  maskUrl?: string; // We now pass the existing mask in
  onClose: () => void;
  onSave: (maskUrl: string) => void; // We now return the MASK, not the image
}

const EraserModal: React.FC<EraserModalProps> = ({ isOpen, imageUrl, maskUrl, onClose, onSave }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null); // Hidden canvas to store the mask
  
  const [brushSize, setBrushSize] = useState(20);
  const [isDrawing, setIsDrawing] = useState(false);
  
  const [history, setHistory] = useState<ImageData[]>([]); // Visual history
  const [maskHistory, setMaskHistory] = useState<ImageData[]>([]); // Mask history
  const MAX_HISTORY = 20;
  
  const [cursorPos, setCursorPos] = useState<{x: number, y: number} | null>(null);
  const [canvasScale, setCanvasScale] = useState(1);

  // Initialize Canvases
  useEffect(() => {
    if (isOpen && canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      const img = new Image();
      img.src = imageUrl;
      
      img.onload = () => {
        if (canvasRef.current && ctx) {
          // 1. Setup Visual Canvas
          canvasRef.current.width = img.width;
          canvasRef.current.height = img.height;
          ctx.drawImage(img, 0, 0);
          
          // 2. Setup Mask Canvas (Hidden)
          if (!maskCanvasRef.current) {
             maskCanvasRef.current = document.createElement('canvas');
          }
          maskCanvasRef.current.width = img.width;
          maskCanvasRef.current.height = img.height;
          const maskCtx = maskCanvasRef.current.getContext('2d');
          
          if (maskCtx) {
            maskCtx.clearRect(0,0, img.width, img.height);
            // If we have an existing mask, load it into the mask canvas
            if (maskUrl) {
                const existingMask = new Image();
                existingMask.onload = () => {
                    maskCtx.drawImage(existingMask, 0, 0);
                    // Also apply it to visual canvas so user sees what was already erased
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.drawImage(existingMask, 0, 0);
                    ctx.globalCompositeOperation = 'source-over';
                };
                existingMask.src = maskUrl;
            }
          }

          setHistory([]);
          setMaskHistory([]);

          const rect = canvasRef.current.getBoundingClientRect();
          setCanvasScale(rect.width / img.width);
        }
      };
    }
  }, [isOpen, imageUrl, maskUrl]);

  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        setCanvasScale(rect.width / canvasRef.current.width);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const saveToHistory = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    
    const maskCanvas = maskCanvasRef.current;
    const maskCtx = maskCanvas?.getContext('2d');

    if (canvas && ctx && maskCanvas && maskCtx) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
      
      setHistory(prev => {
        const h = [...prev, imageData];
        return h.length > MAX_HISTORY ? h.slice(1) : h;
      });
      setMaskHistory(prev => {
        const h = [...prev, maskData];
        return h.length > MAX_HISTORY ? h.slice(1) : h;
      });
    }
  };

  const handleUndo = useCallback(() => {
    if (history.length === 0 || !canvasRef.current || !maskCanvasRef.current) return;
    
    const ctx = canvasRef.current.getContext('2d');
    const maskCtx = maskCanvasRef.current.getContext('2d');
    if (!ctx || !maskCtx) return;

    const lastState = history[history.length - 1];
    const lastMaskState = maskHistory[maskHistory.length - 1];
    
    ctx.putImageData(lastState, 0, 0);
    maskCtx.putImageData(lastMaskState, 0, 0);
    
    setHistory(prev => prev.slice(0, -1));
    setMaskHistory(prev => prev.slice(0, -1));
  }, [history, maskHistory]);

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const handleStart = (e: React.MouseEvent | React.TouchEvent) => {
    saveToHistory();
    setIsDrawing(true);
    erase(e);
  };

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
    if ('touches' in e) {
       // touch logic
    } else {
       setCursorPos({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY });
    }
    if (!isDrawing) return;
    e.preventDefault(); 
    erase(e);
  };

  const handleEnd = () => {
    setIsDrawing(false);
  };

  const erase = (e: React.MouseEvent | React.TouchEvent) => {
    const ctx = canvasRef.current?.getContext('2d');
    const maskCtx = maskCanvasRef.current?.getContext('2d');
    if (!ctx || !maskCtx) return;

    const { x, y } = getPos(e);

    // 1. Update Visuals (Make Transparent)
    ctx.globalCompositeOperation = 'destination-out'; 
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over'; 

    // 2. Update Mask (Add Black Ink to indicate erased area)
    maskCtx.fillStyle = 'black';
    maskCtx.beginPath();
    maskCtx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    maskCtx.fill();
  };

  const handleSave = () => {
    if (maskCanvasRef.current) {
      // Return the MASK, not the visual result
      const newMaskUrl = maskCanvasRef.current.toDataURL('image/png');
      onSave(newMaskUrl);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-in fade-in duration-200">
      {cursorPos && (
        <div 
          className="pointer-events-none fixed z-[60] border-2 border-red-500 rounded-full shadow-sm -translate-x-1/2 -translate-y-1/2 bg-red-500/10"
          style={{ 
            left: cursorPos.x, 
            top: cursorPos.y,
            width: brushSize * canvasScale,
            height: brushSize * canvasScale,
          }}
        />
      )}
      <div className="bg-slate-800 rounded-xl shadow-2xl border border-slate-600 w-full max-w-5xl flex flex-col h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-700 flex justify-between items-center shrink-0 bg-slate-800 rounded-t-xl">
          <div>
            <h3 className="text-xl font-bold text-slate-100 flex items-center gap-2">
              <Eraser size={24} className="text-emerald-400" />
              Eraser Tool
            </h3>
            <p className="text-sm text-slate-400">Erase artifacts. <strong className="text-emerald-400">Edits are preserved</strong> even if you adjust settings later.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleUndo} disabled={history.length === 0} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-30 transition text-sm mr-2">
              <Undo size={16} /> Undo
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition">
              <X size={24} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-200 flex items-center justify-center relative select-none">
             <div className="absolute inset-0 pointer-events-none opacity-20" 
                  style={{ backgroundImage: `linear-gradient(45deg, #808080 25%, transparent 25%), linear-gradient(-45deg, #808080 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #808080 75%), linear-gradient(-45deg, transparent 75%, #808080 75%)`, backgroundSize: '20px 20px', backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px' }} 
             />
             <canvas 
               ref={canvasRef}
               className="border border-slate-300 shadow-xl cursor-none relative z-10 max-w-[95%] max-h-[95%]"
               onMouseDown={handleStart} onMouseMove={handleMove} onMouseUp={handleEnd} onMouseLeave={() => { handleEnd(); setCursorPos(null); }}
               onTouchStart={handleStart} onTouchMove={handleMove} onTouchEnd={handleEnd}
             />
        </div>
        <div className="px-6 py-4 border-t border-slate-700 bg-slate-800 flex items-center gap-6 shrink-0 rounded-b-xl">
          <div className="flex-1 flex items-center gap-4 bg-slate-900/50 p-3 rounded-lg border border-slate-700/50">
            <div className="flex flex-col gap-1 w-full">
              <div className="flex justify-between items-center text-xs font-medium text-slate-400 uppercase tracking-wider">
                <span>Eraser Size</span><span>{brushSize}px</span>
              </div>
              <div className="flex items-center gap-3">
                <input type="range" min="2" max="100" value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-full h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
                <div className="rounded-full bg-white border border-slate-500 shrink-0 shadow-sm" style={{ width: Math.min(32, Math.max(8, brushSize/2)), height: Math.min(32, Math.max(8, brushSize/2)) }}></div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="px-5 py-2.5 rounded-lg text-slate-300 hover:bg-slate-700 transition font-medium border border-transparent hover:border-slate-600">Cancel</button>
            <button onClick={handleSave} className="px-8 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg transition font-bold flex items-center gap-2">
              <Check size={18} /> Save Edits
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Main App Component ---

export default function App() {
  const [images, setImages] = useState<ImageFile[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number>(0);
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 }); 
  const [currentRect, setCurrentRect] = useState<Rect | null>(null); 
  
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{w: number, h: number} | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isGeminiScanning, setIsGeminiScanning] = useState(false);

  const [editingItem, setEditingItem] = useState<Extraction | null>(null);
  
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fitToScreen = useCallback(() => {
    if (naturalSize && containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      const padding = 64; 
      const availW = clientWidth - padding;
      const availH = clientHeight - padding;
      const scaleW = availW / naturalSize.w;
      const scaleH = availH / naturalSize.h;
      const newZoom = Math.min(scaleW, scaleH, 1.0);
      setZoom(newZoom);
    }
  }, [naturalSize]);

  useEffect(() => {
    if (images.length > 0) {
      const img = new Image();
      img.onload = () => {
        setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.src = images[selectedImageIndex].url;
    } else {
      setNaturalSize(null);
    }
  }, [selectedImageIndex, images]);

  useEffect(() => {
    if (naturalSize) fitToScreen();
  }, [naturalSize, fitToScreen]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = -e.deltaY;
      const zoomFactor = 0.001; 
      setZoom(prev => Math.max(0.05, Math.min(5, prev + delta * zoomFactor)));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setIsProcessing(true);
    const files: File[] = Array.from(e.target.files);
    const newImages: ImageFile[] = [];

    try {
      for (const file of files) {
        if (file.type === 'application/pdf') {
          const pdfImages = await convertPdfToImages(file);
          newImages.push(...pdfImages);
        } else if (file.type.startsWith('image/')) {
          newImages.push({
            id: Math.random().toString(36).substring(7),
            url: URL.createObjectURL(file),
            file: file
          });
        }
      }
      setImages(prev => [...prev, ...newImages]);
      if (images.length === 0 && newImages.length > 0) {
        setSelectedImageIndex(0);
      }
    } catch (err) {
      console.error("Error processing files", err);
    } finally {
      setIsProcessing(false);
      e.target.value = ''; 
    }
  };

  const handleGeminiScan = async () => {
    if (!images.length || !imageRef.current) return;
    const currentImage = images[selectedImageIndex];
    setIsGeminiScanning(true);
    try {
      const response = await fetch(currentImage.url);
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });

      const detectedRects = await detectSignaturesWithGemini(base64);

      if (detectedRects.length === 0) {
        alert("Gemini AI didn't find any signatures.");
        setIsGeminiScanning(false);
        return;
      }

      const naturalWidth = imageRef.current.naturalWidth;
      const naturalHeight = imageRef.current.naturalHeight;
      const newExtractions: Extraction[] = [];
      const defaultSettings = { enhance: true, threshold: 160, invert: false, removeBorders: false };

      // Process sequentially to handle async
      for (let i = 0; i < detectedRects.length; i++) {
        const relRect = detectedRects[i];
        const naturalCrop: Rect = {
          x: relRect.x * naturalWidth,
          y: relRect.y * naturalHeight,
          width: relRect.width * naturalWidth,
          height: relRect.height * naturalHeight
        };
        
        if (naturalCrop.width > 5 && naturalCrop.height > 5) {
          const processedUrl = await cropImage(imageRef.current!, naturalCrop, defaultSettings);
          newExtractions.push({
            id: Math.random().toString(36).substring(7),
            sourceImageIndex: selectedImageIndex,
            naturalCrop: naturalCrop,
            imageUrl: processedUrl,
            name: `Gemini_Sig_${extractions.length + i + 1}`,
            timestamp: Date.now(),
            settings: defaultSettings
          });
        }
      }
      setExtractions(prev => [...prev, ...newExtractions]);

    } catch (err) {
      console.error("Gemini Scan Error:", err);
      alert("Failed to analyze image with Gemini.");
    } finally {
      setIsGeminiScanning(false);
    }
  };

  const handleAutoDetect = async () => {
    if (!images.length || !imageRef.current) return;
    setIsDetecting(true);
    setTimeout(async () => {
      try {
        const detectedRects = await detectSignatures(imageRef.current!);
        if (detectedRects.length === 0) {
          alert("No clear signatures found using local algorithm.");
          setIsDetecting(false);
          return;
        }
        const newExtractions: Extraction[] = [];
        const defaultSettings = { enhance: true, threshold: 160, invert: false, removeBorders: false };
        
        for (let i = 0; i < detectedRects.length; i++) {
          const rect = detectedRects[i];
          const processedUrl = await cropImage(imageRef.current!, rect, defaultSettings);
          newExtractions.push({
            id: Math.random().toString(36).substring(7),
            sourceImageIndex: selectedImageIndex,
            naturalCrop: rect,
            imageUrl: processedUrl,
            name: `Auto_Sig_${extractions.length + i + 1}`,
            timestamp: Date.now(),
            settings: defaultSettings
          });
        }
        setExtractions(prev => [...prev, ...newExtractions]);
      } catch (err) {
        console.error("Detection failed:", err);
      } finally {
        setIsDetecting(false);
      }
    }, 100);
  };

  const getRelativeMousePos = (e: React.MouseEvent) => {
    if (!imageRef.current) return { x: 0, y: 0 };
    const rect = imageRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!images.length || isDetecting || isGeminiScanning) return;
    e.preventDefault();
    setIsDrawing(true);
    const pos = getRelativeMousePos(e);
    setStartPos(pos);
    setCurrentRect({ x: pos.x, y: pos.y, width: 0, height: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !currentRect) return;
    e.preventDefault();
    const pos = getRelativeMousePos(e);
    const width = pos.x - startPos.x;
    const height = pos.y - startPos.y;
    setCurrentRect({ x: width > 0 ? startPos.x : pos.x, y: height > 0 ? startPos.y : pos.y, width: Math.abs(width), height: Math.abs(height) });
  };

  const handleMouseUp = async () => {
    if (!isDrawing || !currentRect || !imageRef.current) {
      setIsDrawing(false);
      setCurrentRect(null);
      return;
    }
    const naturalWidth = imageRef.current.naturalWidth;
    const naturalHeight = imageRef.current.naturalHeight;
    const naturalCrop: Rect = {
      x: currentRect.x * naturalWidth,
      y: currentRect.y * naturalHeight,
      width: currentRect.width * naturalWidth,
      height: currentRect.height * naturalHeight
    };

    if (naturalCrop.width > 5 && naturalCrop.height > 5) {
      const defaultSettings = { enhance: true, threshold: 160, invert: false, removeBorders: false };
      const processedUrl = await cropImage(imageRef.current, naturalCrop, defaultSettings);
      const newExtraction: Extraction = {
        id: Math.random().toString(36).substring(7),
        sourceImageIndex: selectedImageIndex,
        naturalCrop: naturalCrop,
        imageUrl: processedUrl,
        name: `Sig_${extractions.length + 1}`,
        timestamp: Date.now(),
        settings: defaultSettings
      };
      setExtractions(prev => [...prev, newExtraction]);
    }
    setIsDrawing(false);
    setCurrentRect(null);
  };

  const deleteExtraction = (id: string) => {
    setExtractions(prev => prev.filter(ex => ex.id !== id));
  };

  const updateExtractionName = (id: string, newName: string) => {
    setExtractions(prev => prev.map(ex => ex.id === id ? { ...ex, name: newName } : ex));
  };

  const updateExtractionSettings = async (id: string, updates: Partial<Extraction['settings']>) => {
    // We need to work with current state, but async inside setState is tricky.
    // So we fetch the item, process it, then update state.
    const extraction = extractions.find(ex => ex.id === id);
    if (!extraction) return;

    // Optimistic UI update for sliders
    setExtractions(prev => prev.map(ex => ex.id === id ? { ...ex, settings: { ...ex.settings, ...updates } } : ex));

    const newSettings = { ...extraction.settings, ...updates };
    const sourceImg = images[extraction.sourceImageIndex];
    
    if (!sourceImg || !imageRef.current) return;

    let targetImg: HTMLImageElement;
    
    // If the currently visible image is the source, use it (cached)
    // Otherwise create a new temp image
    if (imageRef.current && sourceImg.url === imageRef.current.src) {
        targetImg = imageRef.current;
    } else {
        targetImg = new Image();
        targetImg.src = sourceImg.url;
        await new Promise(r => targetImg.onload = r);
    }
    
    // CRITICAL FIX: Pass the existing mask (extraction.editMaskUrl) to the processor
    // This ensures that manual edits are re-applied after re-thresholding
    const newUrl = await cropImage(targetImg, extraction.naturalCrop, newSettings, extraction.editMaskUrl);
    
    setExtractions(prev => prev.map(ex => 
      ex.id === id ? { ...ex, settings: newSettings, imageUrl: newUrl } : ex
    ));
  };

  // Called when EraserModal saves
  const handleSaveEditedMask = async (newMaskUrl: string) => {
    if (!editingItem) return;
    
    // We have a new mask. We need to re-generate the image using current settings + new mask.
    const sourceImg = images[editingItem.sourceImageIndex];
    if (!sourceImg || !imageRef.current) return;

    let targetImg: HTMLImageElement;
    if (imageRef.current && sourceImg.url === imageRef.current.src) {
        targetImg = imageRef.current;
    } else {
        targetImg = new Image();
        targetImg.src = sourceImg.url;
        await new Promise(r => targetImg.onload = r);
    }

    const newUrl = await cropImage(targetImg, editingItem.naturalCrop, editingItem.settings, newMaskUrl);
    
    setExtractions(prev => prev.map(ex => 
      ex.id === editingItem.id ? { 
        ...ex, 
        editMaskUrl: newMaskUrl, // Store the mask persistently
        imageUrl: newUrl 
      } : ex
    ));
    setEditingItem(null);
  };

  const downloadAll = async () => {
     if (extractions.length === 0) return;
     if (!confirm(`Create ZIP for ${extractions.length} signatures?`)) return;
     setIsProcessing(true);
     try {
       const zip = new JSZip();
       const folder = zip.folder("extracted_signatures");
       extractions.forEach((ex) => {
         const base64Data = ex.imageUrl.split(',')[1];
         folder?.file(`${ex.name}.png`, base64Data, { base64: true });
       });
       const content = await zip.generateAsync({ type: "blob" });
       const url = URL.createObjectURL(content);
       const link = document.createElement('a');
       link.href = url;
       link.download = "signatures_bundle.zip";
       document.body.appendChild(link);
       link.click();
       document.body.removeChild(link);
       URL.revokeObjectURL(url);
     } catch (e) {
       console.error("ZIP Error:", e);
       alert("Failed to create zip file.");
     } finally {
       setIsProcessing(false);
     }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-slate-100 font-sans">
      
      <EraserModal 
        isOpen={!!editingItem} 
        imageUrl={editingItem?.imageUrl || ''} 
        maskUrl={editingItem?.editMaskUrl}
        onClose={() => setEditingItem(null)}
        onSave={handleSaveEditedMask}
      />

      <div className="w-64 flex flex-col border-r border-slate-700 bg-slate-800 shrink-0 z-10">
        <div className="p-4 border-b border-slate-700 shrink-0">
          <h1 className="text-xl font-bold flex items-center gap-2 text-emerald-400">
            <Scissors size={20} />
            SigExtractor
          </h1>
          <p className="text-xs text-slate-400 mt-1">Split & Enhance Signatures</p>
        </div>

        <div className="p-4 border-b border-slate-700 shrink-0 space-y-4">
          <label className={`flex flex-col items-center justify-center w-full h-24 px-4 transition border-2 border-dashed rounded-lg cursor-pointer ${isProcessing ? 'bg-slate-800 border-slate-600 opacity-50' : 'bg-slate-700 border-slate-600 hover:border-emerald-500'}`}>
             {isProcessing ? <Loader2 className="animate-spin text-emerald-400" /> : <Upload className="text-slate-400" />}
             <span className="text-xs mt-2 text-slate-400">{isProcessing ? "Processing..." : "Import Images / PDF"}</span>
             <input type="file" multiple className="hidden" accept="image/*,.pdf" onChange={handleFileUpload} disabled={isProcessing} />
          </label>
          
          {images.length > 0 && (
            <div className="pt-2 space-y-2">
              <button
                onClick={handleGeminiScan}
                disabled={isGeminiScanning || isDetecting}
                className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white p-2.5 rounded-lg flex items-center justify-center gap-2 transition group shadow-lg shadow-indigo-900/30"
              >
                {isGeminiScanning ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : (
                  <Bot className="text-white" size={16} />
                )}
                <span className="font-bold text-sm">AI Smart Scan</span>
              </button>
              
              <button
                onClick={handleAutoDetect}
                disabled={isDetecting || isGeminiScanning}
                className="w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 p-2.5 rounded-lg flex items-center justify-center gap-2 transition text-sm border border-slate-600"
              >
                {isDetecting ? (
                  <Loader2 className="animate-spin text-slate-400" size={16} />
                ) : (
                  <Sparkles className="text-yellow-400" size={16} />
                )}
                <span>Auto-Detect (Local)</span>
              </button>
            </div>
          )}
        </div>
        
        {images.length > 0 && (
          <div className="flex-1 overflow-y-auto p-3 custom-scrollbar bg-slate-800/50">
             <div className="space-y-3">
               {images.map((img, idx) => (
                 <button
                    key={img.id}
                    onClick={() => setSelectedImageIndex(idx)}
                    className={`w-full group rounded-lg overflow-hidden transition border-2 text-left ${selectedImageIndex === idx ? 'border-emerald-500 shadow-md bg-slate-700' : 'border-slate-700 hover:border-slate-500 bg-slate-800'}`}
                 >
                   <div className="relative aspect-[3/4] w-full bg-slate-900 border-b border-slate-700/50">
                      <img 
                        src={img.url} 
                        alt={`Page ${idx + 1}`} 
                        className="w-full h-full object-contain opacity-90 group-hover:opacity-100 transition" 
                        loading="lazy"
                      />
                      <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm text-white text-[10px] px-1.5 py-0.5 rounded font-medium">
                        {idx + 1}
                      </div>
                   </div>
                   <div className="p-2 flex items-center gap-2">
                     <ImageIcon size={14} className={selectedImageIndex === idx ? "text-emerald-400" : "text-slate-500"} />
                     <span className={`text-xs truncate font-medium ${selectedImageIndex === idx ? "text-emerald-100" : "text-slate-400"}`}>
                       Page {idx + 1}
                     </span>
                   </div>
                 </button>
               ))}
             </div>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col relative bg-slate-900 overflow-hidden">
        {/* Toolbar */}
        <div className="h-12 border-b border-slate-700 bg-slate-800 flex items-center justify-between px-4 shrink-0 z-20">
          <div className="flex items-center gap-2 text-sm text-slate-400">
             <Scissors size={14} />
             <span>Ctrl+Scroll to Zoom. Drag to crop or use <span className="text-blue-400 font-bold">AI Scan</span></span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fitToScreen} className="p-1.5 hover:bg-slate-700 rounded text-slate-300" title="Fit to Screen">
                <Maximize size={18} />
            </button>
            <div className="h-4 w-px bg-slate-600 mx-1"></div>
            <button onClick={() => setZoom(z => Math.max(0.1, z - 0.1))} className="p-1.5 hover:bg-slate-700 rounded"><ZoomOut size={18} /></button>
            <span className="text-xs w-12 text-center text-slate-400">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(5, z + 0.1))} className="p-1.5 hover:bg-slate-700 rounded"><ZoomIn size={18} /></button>
          </div>
        </div>

        {/* Canvas Area with Scroll & Wheel Support - REFACTORED FOR ZOOM STABILITY */}
        <div 
            className="flex-1 overflow-auto bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px] relative" 
            ref={containerRef}
            onWheel={handleWheel} // Attach Zoom Handler
        >
          {images.length > 0 ? (
            <div className="min-w-full min-h-full flex items-center justify-center p-8">
              <div 
                className="relative shadow-2xl ring-1 ring-slate-700 select-none bg-white transition-[width,height] duration-75 ease-out"
                style={{ 
                  width: naturalSize ? Math.round(naturalSize.w * zoom) : 'auto',
                  height: naturalSize ? Math.round(naturalSize.h * zoom) : 'auto',
                  cursor: 'crosshair',
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <img 
                  ref={imageRef}
                  src={images[selectedImageIndex].url}
                  alt="Work area"
                  className="block w-full h-full object-contain pointer-events-none" 
                  draggable={false}
                />
                {currentRect && (
                  <div 
                    className="absolute border-2 border-emerald-400 bg-emerald-400/20 pointer-events-none"
                    style={{
                      left: `${currentRect.x * 100}%`,
                      top: `${currentRect.y * 100}%`,
                      width: `${currentRect.width * 100}%`,
                      height: `${currentRect.height * 100}%`
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
             <div className="flex flex-col items-center justify-center h-full text-slate-500 opacity-50 absolute inset-0">
               <Layers size={64} className="mb-4" />
               <p>No document loaded</p>
            </div>
          )}
        </div>
      </div>

      <div className="w-96 bg-slate-800 border-l border-slate-700 flex flex-col shrink-0 z-10">
         <div className="p-4 border-b border-slate-700 flex items-center justify-between">
           <h2 className="font-bold text-slate-200">Signatures ({extractions.length})</h2>
           {extractions.length > 0 && (
             <button 
              onClick={downloadAll}
              disabled={isProcessing}
              className="flex items-center gap-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-3 py-1.5 rounded transition font-medium"
             >
               {isProcessing ? <Loader2 size={14} className="animate-spin" /> : <FileArchive size={14} />} 
               Save as ZIP
             </button>
           )}
         </div>

         <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
           {extractions.length === 0 && (
             <div className="text-center text-slate-500 text-sm mt-10 space-y-2">
               <Scissors className="mx-auto opacity-50" />
               <p>Draw a box on the document<br/>or use AI Scan.</p>
             </div>
           )}
           
           {extractions.map((item, i) => (
             <div key={item.id} className="bg-slate-700 rounded-lg p-3 border border-slate-600 shadow-sm relative animate-in slide-in-from-right duration-300">
               <div className="flex justify-between items-start mb-3">
                 <input 
                   type="text" 
                   value={item.name}
                   onChange={(e) => updateExtractionName(item.id, e.target.value)}
                   className="bg-transparent border-b border-transparent focus:border-emerald-500 text-sm font-semibold text-slate-200 focus:outline-none w-full mr-2 px-1 min-w-0"
                   title={item.name}
                 />
                 <button onClick={() => deleteExtraction(item.id)} className="text-slate-500 hover:text-red-400 transition ml-2 shrink-0">
                   <Trash2 size={16} />
                 </button>
               </div>
               
               <div className="h-28 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-white/5 rounded border border-slate-600 flex items-center justify-center overflow-hidden mb-3 relative group">
                  <img src={item.imageUrl} alt={item.name} className="max-h-full max-w-full object-contain" />
                  
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center backdrop-blur-[1px]">
                     <button 
                      onClick={() => setEditingItem(item)}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-full shadow-lg transform translate-y-2 group-hover:translate-y-0 transition flex items-center gap-2 text-sm font-bold border border-emerald-400"
                     >
                       <Eraser size={16} /> Edit / Erase
                     </button>
                  </div>
                  
                  <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition pointer-events-none">
                    <span className="text-[10px] bg-black/50 text-white px-1 rounded">
                      Page {item.sourceImageIndex + 1}
                    </span>
                  </div>
               </div>

               <div className="mt-3 space-y-2">
                 <div className={`flex items-center justify-between p-2 rounded border transition-colors ${item.settings.removeBorders ? 'bg-emerald-900/20 border-emerald-500/50' : 'bg-slate-800 border-slate-600 group hover:border-emerald-500/30'}`}>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-200 cursor-pointer select-none w-full">
                      <ScanLine size={16} className={item.settings.removeBorders ? "text-emerald-400" : "text-slate-400"} />
                      Remove Borders
                    </label>
                    <input 
                      type="checkbox" 
                      checked={item.settings.removeBorders}
                      onChange={(e) => updateExtractionSettings(item.id, { removeBorders: e.target.checked })}
                      className="accent-emerald-500 w-4 h-4 cursor-pointer"
                    />
                 </div>

                 <div className="bg-slate-800 p-2 rounded border border-slate-700/50">
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 text-xs text-slate-300">
                        <Wand2 size={14} /> Auto-Clean / Binarize
                      </label>
                      <input 
                          type="checkbox"
                          checked={item.settings.enhance}
                          onChange={(e) => updateExtractionSettings(item.id, { enhance: e.target.checked })}
                          className="accent-emerald-500"
                      />
                    </div>
                    
                    {(item.settings.enhance || item.settings.removeBorders) && (
                      <div className="space-y-3 pt-2 border-t border-slate-700/50">
                        <div>
                          <div className="flex justify-between text-slate-400 text-[10px] mb-1 uppercase tracking-wider">
                            <span>Threshold</span>
                            <span>{item.settings.threshold}</span>
                          </div>
                          <input 
                            type="range" 
                            min="0" 
                            max="255" 
                            value={item.settings.threshold}
                            onChange={(e) => updateExtractionSettings(item.id, { threshold: parseInt(e.target.value) })}
                            className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-1 text-xs text-slate-400">
                             <RefreshCw size={12} /> Invert Colors
                          </label>
                          <input 
                              type="checkbox"
                              checked={item.settings.invert}
                              onChange={(e) => updateExtractionSettings(item.id, { invert: e.target.checked })}
                              className="accent-emerald-500"
                          />
                        </div>
                      </div>
                    )}
                 </div>
               </div>

               <div className="mt-3 text-right border-t border-slate-600/50 pt-2">
                  <a 
                    href={item.imageUrl} 
                    download={`${item.name}.png`}
                    className="text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:underline flex items-center justify-end gap-1"
                  >
                    <Download size={12} /> Download PNG
                  </a>
               </div>
             </div>
           ))}
         </div>
      </div>

    </div>
  );
}