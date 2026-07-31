"use client";

import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UploadDropzone } from "@/components/UploadDropzone";
import { saveProject } from "@/lib/db";
import { fileToPages } from "@/lib/pdf";
import { LANGUAGES, type ComicPage } from "@/lib/types";

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("tr");
  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [pages, setPages] = useState<ComicPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | File[]) {
    setBusy(true);
    setError(null);
    try {
      const incoming = Array.from(files);
      const converted: ComicPage[] = [];
      for (const file of incoming) {
        converted.push(...(await fileToPages(file)));
      }
      setPages((prev) => [...prev, ...converted]);
      if (!name.trim() && incoming[0]) {
        setName(incoming[0].name.replace(/\.[^.]+$/, ""));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dosyalar işlenemedi");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError("Proje adı gerekli");
      return;
    }
    if (pages.length === 0) {
      setError("En az bir görsel veya PDF yükle");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const now = Date.now();
      const id = nanoid();
      await saveProject({
        id,
        name: name.trim(),
        targetLanguage,
        sourceLanguage,
        createdAt: now,
        updatedAt: now,
        pages,
      });
      router.push(`/projects/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Proje kaydedilemedi");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rise-in mb-8">
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight md:text-4xl">
          Yeni proje
        </h1>
        <p className="muted mt-2">
          Manga sayfalarını yükle, hedef dili seç, çeviriye hazır hale getir.
        </p>
      </div>

      <div className="panel rise-in-delay space-y-5 p-5 md:p-7">
        <div className="field">
          <label htmlFor="name">Proje adı</label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. One Piece Ch. 1100"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field">
            <label htmlFor="source">Kaynak dil</label>
            <select
              id="source"
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
            >
              <option value="auto">Otomatik algıla</option>
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="target">Hedef dil</label>
            <select
              id="target"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <UploadDropzone onFiles={handleFiles} disabled={busy} />

        {pages.length > 0 && (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="font-semibold">{pages.length} sayfa hazır</p>
              <button type="button" className="btn btn-ghost" onClick={() => setPages([])}>
                Temizle
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {pages.map((page) => (
                <div key={page.id} className="overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.imageDataUrl}
                    alt={page.name}
                    className="aspect-[3/4] w-full object-cover"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        )}

        <button
          type="button"
          className="btn btn-accent w-full"
          disabled={busy}
          onClick={() => void handleCreate()}
        >
          {busy ? "İşleniyor…" : "Projeyi oluştur"}
        </button>
      </div>
    </div>
  );
}
