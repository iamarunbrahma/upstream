import { ArrowUpRight, Sprout } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { demoEnabled } from "@/lib/demo/accounts";

export const REPO_URL = "https://github.com/iamarunbrahma/upstream";

/** The site's mark: a small green tile with a sprout. */
export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/30">
        <Sprout className="size-4" />
      </span>
      Upstream
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Logo />
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/#how">How it works</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/maintainer">Maintainers</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
          {demoEnabled() && (
            <form method="post" action="/demo/start" className="ml-1">
              <Button type="submit" size="sm">
                Try the demo
              </Button>
            </form>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-10 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>An entry in the PayPal AI Hackathon. It all runs on the PayPal sandbox, so no real money moves.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/maintainer" className="font-medium text-foreground hover:text-primary">
            For maintainers
          </Link>
          <a href={REPO_URL} className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary">
            Source on GitHub, MIT license <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>
    </footer>
  );
}
