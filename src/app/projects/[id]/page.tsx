"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { UploadDropzone } from "@/components/UploadDropzone";
import { getProject, saveProject } from "@/lib/db";
import { fileToPages } from "@/lib/pdf";
import { reapplyBubblesToImage, translatePageImage } from "@/lib/translateClient";
import { LANGUAGES, type ComicPage, type ComicProject } from "@/lib/types";

function languageLabel(code: string) {
  if (code === "auto") return "Otomatik";
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

function statusBadge(status: ComicPage["status"]) {
  if (status === "done") return <span className="badge badge-ok">Çevrildi</span>;
  if (status === "translating") return <span className="badge badge-warn">Çevriliyor…</span>;
  if (status === "error") return <span className="badge badge-err">Hata</span>;
  return <span className="badge">Bekliyor</span>;
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ComicProject | null | undefined>(undefined);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"translated" | "original" | "redzone">(
    "translated",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const found = await getProject(params.id);
      setProject(found ?? null);
      if (found?.pages[0]) setSelectedPageId(found.pages[0].id);
    })();
  }, [params.id]);

  const selectedPage = useMemo(
    () => project?.pages.find((p) => p.id === selectedPageId) ?? null,
    [project, selectedPageId],
  );

  const displaySrc = useMemo(() => {
    if (!selectedPage) return null;
    if (viewMode === "redzone" && selectedPage.debugImageDataUrl) {
      return selectedPage.debugImageDataUrl;
    }
    if (
      viewMode === "translated" &&
      selectedPage.translatedImageDataUrl &&
      selectedPage.status === "done"
    ) {
      return selectedPage.translatedImageDataUrl;
    }
    return selectedPage.imageDataUrl;
  }, [selectedPage, viewMode]);

  async function persist(next: ComicProject) {
    setProject(next);
    await saveProject(next);
  }

  async function translateOne(pageId: string) {
    const current = (await getProject(params.id)) ?? project;
    if (!current) return;
    setError(null);
    setViewMode("translated");

    const updating: ComicProject = {
      ...current,
      pages: current.pages.map((page) =>
        page.id === pageId
          ? { ...page, status: "translating", error: undefined }
          : page,
      ),
    };
    await persist(updating);

    try {
      const page = updating.pages.find((p) => p.id === pageId);
      if (!page) return;

      const { bubbles, translatedImageDataUrl, debugImageDataUrl } =
        await translatePageImage({
          imageDataUrl: page.imageDataUrl,
          mimeType: page.mimeType,
          targetLanguage: languageLabel(updating.targetLanguage),
          sourceLanguage: updating.sourceLanguage,
        });

      const latest = (await getProject(params.id)) ?? updating;
      const done: ComicProject = {
        ...latest,
        pages: latest.pages.map((p) =>
          p.id === pageId
            ? {
                ...p,
                bubbles,
                translatedImageDataUrl,
                debugImageDataUrl,
                status: "done",
                error: undefined,
              }
            : p,
        ),
      };
      await persist(done);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Çeviri başarısız";
      setError(message);
      const latest = (await getProject(params.id)) ?? updating;
      const failed: ComicProject = {
        ...latest,
        pages: latest.pages.map((p) =>
          p.id === pageId ? { ...p, status: "error", error: message } : p,
        ),
      };
      await persist(failed);
    }
  }

  async function translateAll() {
    const current = (await getProject(params.id)) ?? project;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const pendingIds = current.pages
        .filter((page) => page.status !== "done")
        .map((page) => page.id);
      for (const pageId of pendingIds) {
        await translateOne(pageId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleMoreFiles(files: FileList | File[]) {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const converted: ComicPage[] = [];
      for (const file of Array.from(files)) {
        converted.push(...(await fileToPages(file)));
      }
      const next = { ...project, pages: [...project.pages, ...converted] };
      await persist(next);
      if (!selectedPageId && converted[0]) setSelectedPageId(converted[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dosyalar eklenemedi");
    } finally {
      setBusy(false);
    }
  }

  function downloadTranslated() {
    if (!selectedPage?.translatedImageDataUrl) return;
    const a = document.createElement("a");
    a.href = selectedPage.translatedImageDataUrl;
    a.download = `${selectedPage.name.replace(/\.[^.]+$/, "")}-translated.jpg`;
    a.click();
  }

  async function reapplyOverlay() {
    if (!project || !selectedPage || selectedPage.bubbles.length === 0) return;
    setBusy(true);
    setError(null);
    setViewMode("translated");
    try {
      const [translatedImageDataUrl, debugImageDataUrl] = await Promise.all([
        reapplyBubblesToImage(selectedPage.imageDataUrl, selectedPage.bubbles, {
          showRedzone: false,
        }),
        reapplyBubblesToImage(selectedPage.imageDataUrl, selectedPage.bubbles, {
          showRedzone: true,
        }),
      ]);
      const latest = (await getProject(params.id)) ?? project;
      await persist({
        ...latest,
        pages: latest.pages.map((p) =>
          p.id === selectedPage.id
            ? {
                ...p,
                translatedImageDataUrl,
                debugImageDataUrl,
                status: "done",
                error: undefined,
              }
            : p,
        ),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Görsele yazılamadı");
    } finally {
      setBusy(false);
    }
  }

  if (project === undefined) {
    return <div className="panel p-8 text-center text-muted">Proje yükleniyor…</div>;
  }

  if (project === null) {
    return (
      <div className="panel mx-auto max-w-lg p-10 text-center">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold">
          Proje bulunamadı
        </h1>
        <p className="muted mt-2 text-sm">
          Bu proje bu tarayıcıda kayıtlı değil. Yeni bir proje oluşturabilirsin.
        </p>
        <Link href="/projects/new" className="btn btn-accent mt-6">
          Yeni proje
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="rise-in mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <Link href="/" className="muted text-sm hover:text-ink">
            ← Projeler
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight md:text-4xl">
            {project.name}
          </h1>
          <p className="muted mt-2 text-sm">
            {languageLabel(project.sourceLanguage)} → {languageLabel(project.targetLanguage)} ·{" "}
            {project.pages.length} sayfa
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || project.pages.length === 0}
            onClick={() => void translateAll()}
          >
            Tümünü çevir
          </button>
          {selectedPage && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || selectedPage.status === "translating"}
              onClick={() => void translateOne(selectedPage.id)}
            >
              Bu sayfayı çevir
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      <div className="grid gap-5 lg:grid-cols-[220px_1fr_320px]">
        <aside className="panel rise-in max-h-[70vh] space-y-2 overflow-auto p-3">
          {project.pages.map((page, index) => (
            <button
              key={page.id}
              type="button"
              onClick={() => setSelectedPageId(page.id)}
              className={`w-full rounded-xl border p-2 text-left transition ${
                selectedPageId === page.id
                  ? "border-ink bg-white"
                  : "border-transparent hover:bg-white/70"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={page.translatedImageDataUrl || page.imageDataUrl}
                alt={page.name}
                className="mb-2 aspect-[3/4] w-full rounded-lg object-cover"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">Sayfa {index + 1}</span>
                {statusBadge(page.status)}
              </div>
            </button>
          ))}
        </aside>

        <section className="panel rise-in-delay overflow-hidden p-3 md:p-4">
          {selectedPage && selectedPage.translatedImageDataUrl && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`btn ${viewMode === "translated" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setViewMode("translated")}
              >
                Çevrilmiş
              </button>
              <button
                type="button"
                className={`btn ${viewMode === "original" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setViewMode("original")}
              >
                Orijinal
              </button>
              {selectedPage.debugImageDataUrl && (
                <button
                  type="button"
                  className={`btn ${viewMode === "redzone" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setViewMode("redzone")}
                >
                  Redzone
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={downloadTranslated}>
                İndir
              </button>
              {selectedPage.bubbles.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void reapplyOverlay()}
                >
                  Görsele uygula
                </button>
              )}
            </div>
          )}

          {selectedPage &&
            selectedPage.bubbles.length > 0 &&
            !selectedPage.translatedImageDataUrl && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-accent"
                  disabled={busy}
                  onClick={() => void reapplyOverlay()}
                >
                  Çeviriyi görsele uygula
                </button>
              </div>
            )}

          {displaySrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displaySrc}
              alt={selectedPage?.name ?? "Sayfa"}
              className="mx-auto max-h-[75vh] w-auto rounded-lg object-contain"
            />
          ) : (
            <div className="flex min-h-[40vh] items-center justify-center text-muted">
              Sayfa seçilmedi
            </div>
          )}
        </section>

        <section className="panel space-y-4 p-4">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-lg font-extrabold">
              Baloncuklar
            </h2>
            <p className="muted mt-1 text-sm">
              Orijinal silinir → Türkçe yazılır. Sınır onarımı artık İngilizceyi
              geri yapıştırmaz.
            </p>
          </div>

          {!selectedPage && <p className="muted text-sm">Bir sayfa seç.</p>}

          {selectedPage?.status === "translating" && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Çevriliyor ve baloncuklar güncelleniyor…
            </p>
          )}

          {selectedPage?.error && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
              {selectedPage.error}
            </p>
          )}

          {selectedPage && selectedPage.bubbles.length === 0 && selectedPage.status === "done" && (
            <p className="muted text-sm">Bu sayfada çevrilecek metin bulunamadı.</p>
          )}

          {selectedPage && selectedPage.bubbles.length === 0 && selectedPage.status === "pending" && (
            <p className="muted text-sm">Çeviriyi başlatmak için “Bu sayfayı çevir”e bas.</p>
          )}

          <div className="space-y-3">
            {selectedPage?.bubbles.map((bubble) => (
              <article key={bubble.id} className="rounded-xl border border-line bg-white p-3">
                <div className="mb-2 text-xs font-bold text-accent">#{bubble.readingOrder}</div>
                <p className="text-sm text-muted">{bubble.original}</p>
                <p className="mt-2 text-sm font-semibold leading-relaxed">{bubble.translated}</p>
              </article>
            ))}
          </div>

          <div className="border-t border-line pt-4">
            <p className="mb-3 text-sm font-semibold">Daha fazla sayfa ekle</p>
            <UploadDropzone onFiles={handleMoreFiles} disabled={busy} />
          </div>
        </section>
      </div>
    </div>
  );
}
