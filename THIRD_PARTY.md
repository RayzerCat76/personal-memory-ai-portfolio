# Third-party sources

- [FastAPI](https://fastapi.tiangolo.com/) supplies the backend HTTP framework; Python's SQLite support supplies local structured storage.
- [React](https://react.dev/) and [Next.js](https://nextjs.org/) supply the browser client framework.
- [Wllama](https://github.com/ngxson/wllama) supplies the bundled browser-local model runtime files under `frontend/public/wllama*`. Its packages declare the MIT license; the upstream license notice is included under `THIRD_PARTY_LICENSES/`.
- [Ollama](https://ollama.com/), [MLX-LM](https://github.com/ml-explore/mlx-lm), Qwen models, and MiniCPM-o provide optional local inference or voice capabilities. Their model weights are not included in this repository.
- Optional persona names refer to characters from Genshin Impact, Arknights, and Honkai: Star Rail. This snapshot does not include official artwork, dialogue, recordings, or training corpora from those games.

OpenAI Codex/ChatGPT also assisted with implementation drafts, tests, debugging, UI text, and documentation. Ray specified the memory and evidence behavior and reviewed the results.
