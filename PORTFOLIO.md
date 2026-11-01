# Personal Memory AI — portfolio guide

**Problem:** an assistant can repeat a plausible personal claim without showing where it came from. I wanted a memory system in which extracted facts remain provisional until a person confirms them and in which an answer carries inspectable evidence.

## First design and current design

The first backend loop accepted a message, extracted a candidate memory, stored it as unconfirmed, allowed confirmation or rejection, searched approved memories, and returned an answer with supporting memory IDs. The source has since grown into a browser/PWA and desktop prototype with richer study, evidence, context, and local-model features. The quick demonstration in this public snapshot exercises the original trust boundary without requiring private data or a model download.

## What works and what is still being developed

On 1 November 2026, the exported backend snapshot passed all ten focused memory-loop tests. The included `backend/demo_memory_loop.py` demonstrates that an unconfirmed candidate provides no evidence and a confirmed one can support an answer. This test does not establish that every browser, mobile, desktop, or optional voice path works on a reviewer's device. Personalization and final recipient delivery remain outside this portfolio snapshot.

The source is a clean export of private `main` at commit `be977ce`. It retains the current application code while excluding local databases, secrets, recipient details, and private project notes. The extra demo and portfolio documentation were added for reviewers; the product source was not modified.

## Contributions and sources

Ray Liu defined the memory-approval and evidence requirements, directed product decisions, and reviewed the implementation and behavior. OpenAI Codex/ChatGPT assisted with implementation drafts, tests, debugging, UI text, and documentation. There were no other human collaborators on this project. [Third-party frameworks and model runtimes](THIRD_PARTY.md) provide infrastructure and inference; I did not train or create those models.
