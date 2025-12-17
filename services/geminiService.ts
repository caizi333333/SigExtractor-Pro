import { GoogleGenAI, Type } from "@google/genai";
import { Rect } from "../types";

// Initialize Gemini Client
// Note: In a production environment, API calls should usually go through a backend proxy 
// to protect the API KEY. For this demo, we use it directly.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Detects signatures in an image using the Gemini 1.5 Pro Vision model.
 * Returns a list of bounding boxes (Rects) normalized to 0.0 - 1.0.
 */
export const detectSignaturesWithGemini = async (base64Data: string): Promise<Rect[]> => {
  try {
    // Remove data URL prefix if present (e.g., "data:image/png;base64,")
    const base64Image = base64Data.split(',')[1] || base64Data;

    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg', // Assuming JPEG for simplicity, or detect from header
              data: base64Image
            }
          },
          {
            text: "Identify all handwritten signatures in this document. Return the bounding boxes for each signature. Ignore printed text unless it overlaps significantly. Return coordinates on a scale of 0 to 1000."
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            signatures: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  ymin: { type: Type.INTEGER, description: "Top Y coordinate (0-1000)" },
                  xmin: { type: Type.INTEGER, description: "Left X coordinate (0-1000)" },
                  ymax: { type: Type.INTEGER, description: "Bottom Y coordinate (0-1000)" },
                  xmax: { type: Type.INTEGER, description: "Right X coordinate (0-1000)" },
                },
                required: ["ymin", "xmin", "ymax", "xmax"]
              }
            }
          }
        }
      }
    });

    const jsonText = response.text;
    if (!jsonText) return [];

    const result = JSON.parse(jsonText);
    const signatures = result.signatures || [];

    // Convert 0-1000 scale to 0.0-1.0 relative scale
    return signatures.map((sig: any) => ({
      x: sig.xmin / 1000,
      y: sig.ymin / 1000,
      width: (sig.xmax - sig.xmin) / 1000,
      height: (sig.ymax - sig.ymin) / 1000
    }));

  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
};