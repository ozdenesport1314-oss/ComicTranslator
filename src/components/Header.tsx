import Link from "next/link";

export function Header() {
  return (
    <header className="site-header page-shell">
      <Link href="/" className="brand brand-mark">
        Comic<span>Translator</span>
      </Link>
      <Link href="/projects/new" className="btn btn-accent">
        Yeni proje
      </Link>
    </header>
  );
}
