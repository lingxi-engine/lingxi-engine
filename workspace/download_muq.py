import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"

from huggingface_hub import snapshot_download

target = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
print("Downloading OpenMuQ/MuQ-MuLan-large to", target)
try:
    p = snapshot_download(
        repo_id="OpenMuQ/MuQ-MuLan-large",
        cache_dir=target,
        allow_patterns=["*.json", "*.bin", "*.md", ".gitattributes", "*.txt"],
    )
    print("DONE:", p)
except Exception as e:
    import traceback
    traceback.print_exc()
    print("FAILED:", e)
