import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.PMA_DESKTOP_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: "http://127.0.0.1:8000/:path*",
      },
    ];
  },
};

export default nextConfig;
