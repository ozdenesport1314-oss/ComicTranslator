export type BubbleBox = {
  /** Normalized 0–1 relative to image width/height */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BubblePoint = {
  /** Normalized 0–1 relative to image width/height */
  x: number;
  y: number;
};

export type BubbleTranslation = {
  id: string;
  original: string;
  translated: string;
  readingOrder: number;
  /** Text region inside the bubble */
  box: BubbleBox;
  /** Full bubble bounds (optional; falls back to expanded text box) */
  bubbleBox?: BubbleBox;
  /** Clockwise balloon contour; preferred over rectangular bubbleBox */
  bubblePolygon?: BubblePoint[];
  /** False for floating/SFX text that has no balloon */
  hasBubble?: boolean;
};

export type ComicPage = {
  id: string;
  name: string;
  imageDataUrl: string;
  mimeType: string;
  translatedImageDataUrl?: string;
  debugImageDataUrl?: string;
  bubbles: BubbleTranslation[];
  status: "pending" | "translating" | "done" | "error";
  error?: string;
};

export type ComicProject = {
  id: string;
  name: string;
  targetLanguage: string;
  sourceLanguage: string;
  createdAt: number;
  updatedAt: number;
  pages: ComicPage[];
};

export const LANGUAGES = [
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "zh", label: "中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
] as const;
