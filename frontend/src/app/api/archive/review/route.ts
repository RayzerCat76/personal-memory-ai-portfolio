import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const run = promisify(execFile);

export async function POST(request: Request) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid review selection." }, { status: 400 }); }
  const { source, position, selected_ids: ids } = body ?? {};
  if (typeof source !== "string" || !source || source.length > 500
      || !Number.isInteger(position) || position < 0 || position > 1000000
      || !Array.isArray(ids) || !ids.length || ids.length > 17
      || ids.some(id => typeof id !== "string" || !id || id.length > 200)
      || new Set(ids).size !== ids.length) {
    return Response.json({ error: "Select distinct messages from this conversation." }, { status: 400 });
  }
  const root = path.resolve(process.cwd(), "..");
  try {
    const { stdout } = await run("python3", [path.join(root, "scripts/prepare_wechat_context_review.py"),
      ...ids.map(id => `--selected-id=${id}`), "--",
      path.join(root, "data/wechat_all_for_luman/target_dataset/archive_source_index_v2/index.sqlite"),
      source, String(position), "-"], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return Response.json(JSON.parse(stdout), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    if (failure.code === 2 && failure.stdout) {
      try { return Response.json(JSON.parse(failure.stdout), { status: 400 }); } catch { /* unavailable */ }
    }
    return Response.json({ error: "Could not prepare this selection. Try again." }, { status: 503 });
  }
}
