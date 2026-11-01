export const runtime = "nodejs";

export async function POST(request: Request) {
  // Local generation can exceed the rewrite proxy's 30-second deadline.
  // Keep this exception scoped to chat; model and global proxy settings stay intact.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
  try {
    const upstream = await fetch("http://127.0.0.1:8000/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      signal,
      cache: "no-store",
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
    });
  } catch {
    return Response.json({ detail: signal.aborted
      ? "The local answer took too long or was cancelled. Please try again."
      : "The local answer service is unavailable. Please try again." },
    { status: signal.aborted ? 504 : 503 });
  }
}
