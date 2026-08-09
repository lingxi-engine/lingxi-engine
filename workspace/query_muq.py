import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from huggingface_hub import HfApi, hf_hub_download

api = HfApi()
print("=== OpenMuQ/MuQ-MuLan-large files ===")
try:
    for f in api.list_repo_files("OpenMuQ/MuQ-MuLan-large"):
        print(" ", f)
except Exception as e:
    print("FAILED:", e)

print("=== model info ===")
try:
    info = api.model_info("OpenMuQ/MuQ-MuLan-large", files_metadata=True)
    for s in info.siblings:
        print(s.rfilename, getattr(s, "size", "?"))
except Exception as e:
    print("FAILED:", e)
