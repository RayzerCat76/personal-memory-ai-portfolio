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

See [PORTFOLIO.md](PORTFOLIO.md) for the design process, current scope, limitations, and contribution credits. See [THIRD_PARTY.md](THIRD_PARTY.md) for frameworks, model runtimes, and bundled browser runtime attribution.
