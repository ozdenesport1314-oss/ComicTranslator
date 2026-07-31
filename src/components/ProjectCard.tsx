"use client";

import Link from "next/link";
import type { ComicProject } from "@/lib/types";
import { LANGUAGES } from "@/lib/types";

function languageLabel(code: string) {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function ProjectCard({
  project,
  onDelete,
}: {
  project: ComicProject;
  onDelete: (id: string) => void;
}) {
  const doneCount = project.pages.filter((p) => p.status === "done").length;

  return (
    <article className="panel rise-in p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-xl font-extrabold tracking-tight">
            {project.name}
          </h2>
          <p className="muted mt-1 text-sm">
            {languageLabel(project.sourceLanguage)} → {languageLabel(project.targetLanguage)}
          </p>
        </div>
        <span className="badge">
          {doneCount}/{project.pages.length} sayfa
        </span>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2">
        {project.pages.slice(0, 3).map((page) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={page.id}
            src={page.imageDataUrl}
            alt={page.name}
            className="aspect-[3/4] w-full rounded-lg object-cover"
          />
        ))}
        {project.pages.length === 0 && (
          <div className="col-span-3 rounded-lg bg-paper px-3 py-8 text-center text-sm text-muted">
            Henüz sayfa yok
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Link href={`/projects/${project.id}`} className="btn btn-primary flex-1">
          Aç
        </Link>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (confirm(`“${project.name}” silinsin mi?`)) onDelete(project.id);
          }}
        >
          Sil
        </button>
      </div>
    </article>
  );
}
