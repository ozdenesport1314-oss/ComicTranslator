"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ProjectCard } from "@/components/ProjectCard";
import { deleteProject, listProjects } from "@/lib/db";
import type { ComicProject } from "@/lib/types";

export default function HomePage() {
  const [projects, setProjects] = useState<ComicProject[] | null>(null);

  async function refresh() {
    setProjects(await listProjects());
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div>
      <section className="rise-in mb-10 grid gap-6 md:grid-cols-[1.2fr_0.8fr] md:items-end">
        <div>
          <p className="badge mb-4">Gemini destekli</p>
          <h1 className="max-w-xl font-[family-name:var(--font-display)] text-4xl font-extrabold tracking-tight md:text-5xl">
            ComicTranslator
          </h1>
          <p className="muted mt-4 max-w-lg text-base leading-relaxed md:text-lg">
            Manga sayfalarını veya PDF’lerini yükle, baloncuklardaki metinleri istediğin dile
            çevir.
          </p>
        </div>
        <div className="rise-in-delay panel p-5">
          <p className="font-[family-name:var(--font-display)] text-lg font-extrabold">
            Nasıl çalışır?
          </p>
          <ol className="muted mt-3 space-y-2 text-sm leading-relaxed">
            <li>1. Yeni proje oluştur</li>
            <li>2. PDF veya görselleri yükle</li>
            <li>3. Hedef dili seç, Gemini ile çevir</li>
          </ol>
          <Link href="/projects/new" className="btn btn-accent mt-5 w-full">
            Yeni proje başlat
          </Link>
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight">
            Projelerim
          </h2>
          {projects && <span className="muted text-sm">{projects.length} proje</span>}
        </div>

        {projects === null && (
          <div className="panel p-8 text-center text-muted">Projeler yükleniyor…</div>
        )}

        {projects && projects.length === 0 && (
          <div className="panel p-10 text-center">
            <p className="font-[family-name:var(--font-display)] text-xl font-extrabold">
              Henüz proje yok
            </p>
            <p className="muted mx-auto mt-2 max-w-md text-sm">
              İlk manga çeviri projeni oluşturmak için yeni proje butonuna bas.
            </p>
            <Link href="/projects/new" className="btn btn-primary mt-6">
              Yeni proje
            </Link>
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onDelete={async (id) => {
                  await deleteProject(id);
                  await refresh();
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
