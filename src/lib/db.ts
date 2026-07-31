import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ComicProject } from "./types";

interface ComicTranslatorDB extends DBSchema {
  projects: {
    key: string;
    value: ComicProject;
    indexes: { "by-updated": number };
  };
}

const DB_NAME = "comic-translator";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ComicTranslatorDB>> | null = null;

function getDb() {
  if (typeof window === "undefined") {
    throw new Error("IndexedDB is only available in the browser");
  }
  if (!dbPromise) {
    dbPromise = openDB<ComicTranslatorDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore("projects", { keyPath: "id" });
        store.createIndex("by-updated", "updatedAt");
      },
    });
  }
  return dbPromise;
}

export async function listProjects(): Promise<ComicProject[]> {
  const db = await getDb();
  const projects = await db.getAllFromIndex("projects", "by-updated");
  return projects.reverse();
}

export async function getProject(id: string): Promise<ComicProject | undefined> {
  const db = await getDb();
  return db.get("projects", id);
}

export async function saveProject(project: ComicProject): Promise<void> {
  const db = await getDb();
  await db.put("projects", { ...project, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("projects", id);
}
