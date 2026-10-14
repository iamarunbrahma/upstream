import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@upstream/core"],
  serverExternalPackages: ["@electric-sql/pglite", "@paypal/agent-toolkit"],
  // No other site may frame these pages: a hidden frame could trick a click on "Continue" or a setting.
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ],
    },
  ],
};

export default config;
