import { selectLocalAiProfile } from "../src/lib/device-capabilities";

type Fixture = Parameters<typeof selectLocalAiProfile>[0];
const base: Fixture = { runtimeSmoke: true, indexedDb: true, webCrypto: true, cacheStorage: true, webGpu: false, hardwareConcurrency: 8, deviceMemoryGb: 8 };
const checks: string[] = [];
function expect(name: string, actual: string, wanted: string) { if (actual !== wanted) throw new Error(`${name}: expected ${wanted}, got ${actual}`); checks.push(name); }
expect("balanced WASM floor", selectLocalAiProfile(base).id, "wasm-balanced");
expect("constrained WASM", selectLocalAiProfile({ ...base, hardwareConcurrency: 4, deviceMemoryGb: 4 }).id, "wasm-constrained");
expect("balanced WebGPU", selectLocalAiProfile({ ...base, webGpu: true }).id, "webgpu-balanced");
expect("constrained WebGPU", selectLocalAiProfile({ ...base, webGpu: true, hardwareConcurrency: 2, deviceMemoryGb: 4 }).id, "webgpu-constrained");
expect("conservative WASM overrides WebGPU", selectLocalAiProfile({ ...base, webGpu: true }, { forceWasm: true }).id, "wasm-balanced");
expect("runtime failure blocks AI", selectLocalAiProfile({ ...base, runtimeSmoke: false }).id, "unavailable");
expect("missing durable storage blocks AI", selectLocalAiProfile({ ...base, indexedDb: false }).id, "unavailable");
console.log(JSON.stringify({ checks: checks.length, passed: checks }));
