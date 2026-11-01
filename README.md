# Personal Memory AI

A private-by-design assistant prototype that proposes memories from messages, asks for confirmation, and shows which confirmed memories support an answer. The source includes a browser/PWA client and desktop delivery work; this public portfolio snapshot starts with the core memory trust loop.

## Try the core loop in five minutes

Requires Python 3.11+. From this repository:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
python demo_memory_loop.py
```

The demonstration uses a temporary database and the deterministic heuristic provider, so it downloads no model and stores no personal data. It prints the answer's evidence count before and after a candidate memory is confirmed. To explore the API, start `uvicorn app.main:app --reload` from `backend` and open `http://127.0.0.1:8000/docs`.

## Try the browser prototype

The browser-local memory mode needs Node.js and no backend or model download. From this repository:

```sh
cd frontend
npm ci
NEXT_PUBLIC_BROWSER_MEMORY_ENABLED=1 npm run dev -- --port 3000
```

Open **http://localhost:3000** (use `localhost` for the Next.js development server). Select **Open my memory** if the introduction appears. Under **Anything worth remembering?**, enter a sample preference such as “I prefer code review notes with one concrete before-and-after example.” Select **Remember**, then **Keep** on the proposed memory. Ask “How should you write my code review notes?” in the message box. The reply should cite the confirmed memory and expose its original evidence. This mode stores sample data in the browser; use fictional or disposable text when reviewing it.

See [PORTFOLIO.md](PORTFOLIO.md) for the design process, current scope, limitations, and contribution credits. See [THIRD_PARTY.md](THIRD_PARTY.md) for frameworks, model runtimes, and bundled browser runtime attribution.

## Where to look in the source

The [build-process map](docs/BUILD_PROCESS.md) traces the original trust rule into the backend, browser prototype, and focused tests. For a short code review, start with [the backend demonstration](backend/demo_memory_loop.py), [candidate extraction](backend/app/extraction.py), [the memory service](backend/app/service.py), [the browser-local memory logic](frontend/src/lib/browser-memory.ts), and [the memory-loop tests](backend/tests/test_memory_loop.py). The public repository is a sanitized source snapshot, so its two publication commits are not the original development history.
