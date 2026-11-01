# From Ray seed memories

Real birthday seed data belongs in `backend/data/friend_seed.json`. The entire `data/` directory is gitignored, so the recipient's personal details stay local even though the code lives in GitHub.

Start from the template:

```bash
cd backend
mkdir -p data
cp examples/friend_seed.example.json data/friend_seed.json
```

Each entry looks like:

```json
{
  "id": "robotics-software",
  "type": "preference",
  "content": "Prefers software work to mechanical work in robotics projects",
  "note": "Ray's observation: this came up when we discussed project roles.",
  "confidence": 0.45,
  "importance": 0.8,
  "subject": "robotics role"
}
```

Rules:

- `id` must be unique and stable. It prevents duplicate imports.
- `type` must be one of the backend memory types.
- `content` is the proposed memory shown to the recipient.
- `note` explains why Ray thinks it is true and is shown as evidence.
- Keep `confidence` below `0.6` for observations supplied by a friend unless there is direct evidence.
- `importance` controls how prominent the memory may become after confirmation.
- `subject` is optional and helps later contradiction/supersession logic.

When the frontend opens, it asks the backend to import this file. Seed memories always begin as `unconfirmed` with source type `friend_seed`.

The recipient can choose:

- **Accurate** — confirms the memory and allows retrieval.
- **Sort of** — records the feedback but keeps the memory out of trusted retrieval until a correction tool is used.
- **Slander** — rejects the memory and excludes it from retrieval.

Calibration feedback is stored locally in `backend/data/friend_seed_feedback.json`.
