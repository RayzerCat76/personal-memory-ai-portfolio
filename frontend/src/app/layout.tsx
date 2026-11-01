import type { Metadata } from "next";
import "./globals.css";
import "./gift.css";
import PwaRegistrar from "@/components/PwaRegistrar";

export const metadata: Metadata = {
  title: "Personal Memory",
  description: "A private, inspectable memory system.",
  manifest: "/manifest.webmanifest",
  icons: { icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icon-512.png", sizes: "512x512", type: "image/png" }, { url: "/icon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Personal Memory", statusBarStyle: "default" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><PwaRegistrar />{children}</body>
    </html>
  );
}
