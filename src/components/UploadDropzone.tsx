"use client";

import { useRef, useState } from "react";

type UploadDropzoneProps = {
  onFiles: (files: FileList | File[]) => void;
  disabled?: boolean;
};

export function UploadDropzone({ onFiles, disabled }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  return (
    <div
      className="dropzone"
      data-active={active}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        if (disabled) return;
        if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
      }}
    >
      <p className="font-[family-name:var(--font-display)] text-lg font-extrabold tracking-tight">
        PDF veya manga sayfalarını bırak
      </p>
      <p className="muted mx-auto mt-2 max-w-md text-sm">
        PNG, JPG, WEBP veya PDF yükleyebilirsin. PDF sayfaları otomatik görsele çevrilir.
      </p>
      <button
        type="button"
        className="btn btn-primary mt-5"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Dosya seç
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
