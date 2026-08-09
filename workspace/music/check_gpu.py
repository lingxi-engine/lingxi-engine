import torch
print("cuda available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device:", torch.cuda.get_device_name(0))
    print("vram GB:", torch.cuda.get_device_properties(0).total_memory / 1e9)
print("cpu threads:", torch.get_num_threads())
try:
    import einops
    print("einops OK", einops.__version__)
except Exception as e:
    print("einops MISS", e)
try:
    import transformers
    print("transformers OK", transformers.__version__)
except Exception as e:
    print("transformers MISS", e)
try:
    import muq
    print("muq OK")
except Exception as e:
    print("muq MISS", e)
try:
    import ema_pytorch
    print("ema_pytorch OK")
except Exception as e:
    print("ema_pytorch MISS", e)
