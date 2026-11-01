import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const run = promisify(execFile);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  const offset = params.get("offset") ?? "0";
  const target = params.get("target") ?? "0";
  if (!query || query.length > 200) return Response.json({ error: "Enter 1–200 characters." }, { status: 400 });
  if (!/^\d+$/.test(offset) || Number(offset) > 1000000 || !["0", "1"].includes(target)) {
    return Response.json({ error: "Invalid search page or sender filter." }, { status: 400 });
  }
  const root = path.resolve(process.cwd(), "..");
  try {
    const { stdout } = await run("python3", [path.join(root, "scripts/search_wechat_archive_local.py"),
      path.join(root, "data/wechat_all_for_luman/target_dataset/archive_source_index_v2/index.sqlite"),
      "--offset", offset, ...(target === "1" ? ["--target-only"] : []), "--", query],
    { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return Response.json(JSON.parse(stdout), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "The local chat archive is unavailable on this computer." }, { status: 503 });
  }
}
