export const metadata = {
  title: "Upstream",
  description: "Your AI coding agent pays back the open source it builds with.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
