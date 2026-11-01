import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const run = promisify(execFile);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get("source") ?? "";
  const position = params.get("position") ?? "";
  if (!source || source.length > 500 || !/^\d+$/.test(position) || Number(position) > 1000000) {
    return Response.json({ error: "Invalid source identity." }, { status: 400 });
  }
  const root = path.resolve(process.cwd(), "..");
  try {
    const { stdout } = await run("python3", [path.join(root, "scripts/wechat_archive_context.py"), "--",
      path.join(root, "data/wechat_all_for_luman/target_dataset/archive_source_index_v2/index.sqlite"), source, position],
    { timeout: 15000, maxBuffer: 128 * 1024 });
    return Response.json(JSON.parse(stdout), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not read context for this source message." }, { status: 503 });
  }
}
