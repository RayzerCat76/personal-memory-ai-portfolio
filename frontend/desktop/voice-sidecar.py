import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Personal Memory AI local voice sidecar")
    parser.add_argument("--comni-app", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--port", type=int, default=22710)
    args = parser.parse_args()

    resources = args.comni_app / "Contents" / "Resources"
    server_dir = resources / "apps" / "server"
    llama_server = resources / "build" / "bin" / "llama-server"
    ref_audio = resources / "apps" / "assets" / "ref_audio" / "ref_minicpm_signature.wav"
    for required in (server_dir, llama_server, ref_audio, args.model_dir):
        if not required.exists():
            raise FileNotFoundError(str(required))

    args.data_dir.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(server_dir))
    import config
    config._config = config.ServiceConfig(**{
        "backend": "cpp",
        "model": {"model_path": "unused-for-cpp-backend"},
        "audio": {"ref_audio_path": str(ref_audio), "playback_delay_ms": 200},
        "service": {
            "gateway_port": 18006,
            "worker_base_port": args.port,
            "max_queue_size": 8,
            "request_timeout": 300.0,
            "compile": False,
            "data_dir": str(args.data_dir),
        },
        "recording": {"enabled": False},
        "cpp_backend": {
            "model_dir": str(args.model_dir),
            "llm_model": "MiniCPM-o-4_5-Q4_K_M.gguf",
            "cpp_server_port": 19070,
            "ctx_size": 2048,
            "n_gpu_layers": 99,
            "vision_backend": "metal",
            "llamacpp_root": str(resources),
        },
    })

    from core.processors.cpp_backend import CppBackendWorker
    CppBackendWorker._find_server_binary = lambda self: str(llama_server)
    original_init = CppBackendWorker.__init__
    def writable_init(self, *init_args, **init_kwargs):
        original_init(self, *init_args, **init_kwargs)
        self._output_dir = str(args.data_dir / f"omni-output-{self._cpp_server_port}")
    CppBackendWorker.__init__ = writable_init
    import worker
    sys.argv = [
        "voice-sidecar",
        "--host", "127.0.0.1",
        "--port", str(args.port),
        "--gpu-id", "0",
        "--worker-index", "0",
    ]
    worker.main()


if __name__ == "__main__":
    main()
