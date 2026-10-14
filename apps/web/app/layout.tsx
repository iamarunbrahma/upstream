import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SiteFooter, SiteHeader } from "./ui/chrome";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Upstream",
  description: "Your AI coding agent pays back the open source it builds with.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans antialiased", sans.variable, mono.variable)}>
      <body className="min-h-dvh">
        <TooltipProvider>
          <SiteHeader />
          {children}
          <SiteFooter />
        </TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
