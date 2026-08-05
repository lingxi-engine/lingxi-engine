# Check if python-docx is available
import importlib
for mod_name in ['docx', 'docx.shared', 'docx.enum.text', 'docx.oxml.ns']:
    try:
        importlib.import_module(mod_name)
        print(f"{mod_name} OK")
    except ImportError:
        print(f"{mod_name} NOT FOUND")
