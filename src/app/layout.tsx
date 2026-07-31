import type { Metadata } from "next";
import { Figtree, Sora } from "next/font/google";
import { Header } from "@/components/Header";
import "./globals.css";

const display = Sora({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

const body = Figtree({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "ComicTranslator — Manga baloncuk çevirisi",
  description:
    "Manga ve çizgi roman sayfalarını yükle, Gemini ile konuşma baloncuklarını istediğin dile çevir.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr" className={`${display.variable} ${body.variable} h-full`}>
      <body className="min-h-full antialiased">
        <Header />
        <main className="page-shell pb-16 pt-2">{children}</main>
      </body>
    </html>
  );
}
