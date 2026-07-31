export type BubbleTranslation = {
  id: string;
  original: string;
  translated: string;
  readingOrder: number;
};

export type ComicPage = {
  id: string;
  name: string;
  imageDataUrl: string;
  mimeType: string;
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
