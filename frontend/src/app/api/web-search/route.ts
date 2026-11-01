export const runtime = "nodejs";

type SearchResult = { title: string; url: string; snippet: string; provider: string };

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim());
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(decodeHtml(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

export function parseQuarkResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const starts = [...html.matchAll(/<div\s+class="sc\s+[^\"]*"[^>]*data-tpl="[^\"]+"[^>]*>/gi)];
  for (let index = 0; index < starts.length && results.length < 5; index++) {
    const start = starts[index].index ?? 0;
    const end = starts[index + 1]?.index ?? html.indexOf('<a id="pager"', start);
    const block = html.slice(start, end > start ? end : Math.min(html.length, start + 30000));
    if (/&quot;ads&quot;\s*:\s*1/.test(block)) continue;
    const titleMatch = block.match(/<div\s+class="[^\"]*qk-title-text[^\"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!titleMatch) continue;
    const anchorMatch = block.match(/<a[^>]+href="([^\"]+)"[^>]*>/i);
    const url = anchorMatch ? safeHttpUrl(anchorMatch[1]) : null;
    if (!url || seen.has(url)) continue;
    const title = stripHtml(titleMatch[1]);
    if (!title) continue;
    const paragraphMatch = block.match(/<div\s+class="[^\"]*qk-paragraph-text[^\"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = paragraphMatch ? stripHtml(paragraphMatch[1]).slice(0, 420) : "";
    seen.add(url);
    results.push({ title, url, snippet, provider: "Quark Search" });
  }
  return results;
}

export async function POST(request: Request) {
  let body: { query?: unknown; language?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return Response.json({ error: "Invalid search request." }, { status: 400 }); }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 500) return Response.json({ error: "Search query must be 1-500 characters." }, { status: 400 });

  // Quark Search is the default because it is a zero-cost mainland-China search path.
  // The page is server-rendered, so no cloud API key or browser automation is required.
  const url = `https://quark.sm.cn/s?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36",
        "Accept-Language": body.language === "zh" ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9,zh-CN;q=0.6",
      },
      cache: "no-store",
      signal: controller.signal,
      redirect: "follow",
    });
    if (!upstream.ok) return Response.json({ error: "Web search is unavailable." }, { status: 502 });
    const html = await upstream.text();
    const results = parseQuarkResults(html);
    if (!results.length) return Response.json({ error: "Web search returned no readable results." }, { status: 502 });
    return Response.json({ query, results });
  } catch {
    return Response.json({ error: "Web search is unavailable." }, { status: 503 });
  } finally { clearTimeout(timeout); }
}
